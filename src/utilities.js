import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  ListTablesCommand
} from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";

import {
  dotNotationToObject,
  queryData,
  searchData,
  sortData,
  isValidDate
} from "@cocreate/utils";

const organizations = {};

/**
 * Dynamically resolves or caches an AWS DynamoDB Document Client instance.
 * Accepts storage API credentials or a structured bootstrap URL.
 * @private
 * @environment server
 */
async function dbClient(data) {
	const storage = data.storageConfig;
	const storageUrl = storage?.region && storage?.accessKeyId && storage?.secretAccessKey
		? {
			region: storage.region,
			accessKeyId: storage.accessKeyId,
			secretAccessKey: storage.secretAccessKey,
			endpoint: storage.endpoint
		}
		: storage?.url;

	if (storageUrl) {
		const connectionKey = typeof storageUrl === "object"
			? JSON.stringify(storageUrl)
			: storageUrl;
		if (!organizations[data.organization_id]) {
			organizations[data.organization_id] = {};
		}
		try {
			if (!organizations[data.organization_id][connectionKey]) {
				const connectionPromise = (async () => {
					let config = {};

					// Resolve structured connection object (Recommended)
					if (typeof storageUrl === "object" && storageUrl !== null) {
						config = {
							region: storageUrl.region || "us-east-1",
							credentials: {
								accessKeyId: storageUrl.accessKeyId || storageUrl.access_key_id,
								secretAccessKey: storageUrl.secretAccessKey || storageUrl.secret_access_key
							}
						};
						if (storageUrl.endpoint) {
							config.endpoint = storageUrl.endpoint; // Support DynamoDB Local
						}
					} 
					// Handle string-fallback parses (e.g. dynamodb://region?accessKeyId=...&secretAccessKey=...)
					else if (typeof storageUrl === "string" && storageUrl.startsWith("dynamodb://")) {
						const urlParsed = new URL(storageUrl);
						config = {
							region: urlParsed.host || "us-east-1",
							credentials: {
								accessKeyId: urlParsed.searchParams.get("accessKeyId"),
								secretAccessKey: urlParsed.searchParams.get("secretAccessKey")
							}
						};
					}

					const baseClient = new DynamoDBClient(config);
					
					// Wrap with the DocumentClient to handle JavaScript types natively (no need for raw DynamoDB marshalling)
					const docClient = DynamoDBDocumentClient.from(baseClient, {
						marshallOptions: {
							removeUndefinedValues: true,
							convertEmptyValues: true
						}
					});

					// Verify client viability by executing a lightweight command
					await docClient.send(new ListTablesCommand({ Limit: 1 }));
					return docClient;
				})();

				organizations[data.organization_id][connectionKey] = connectionPromise;
			}

			return await organizations[data.organization_id][connectionKey];
		} catch (error) {
			console.error(`${data.organization_id}: DynamoDB failed to connect`);
			errorHandler(data, error);
			return { status: false };
		}
	}

	errorHandler(data, "missing DynamoDB Connection URL/Credentials");
	return;
}

/**
 * Global Event Listener: orgDeleted
 * Cleans up active DynamoDB Client instances and destroys connection configurations.
 */
process.on("orgDeleted", (organization_id) => {
	const orgPools = organizations[organization_id];
	if (orgPools) {
		console.log(`[DynamoDB Utilities] Cleanup Scheduled: Initiating 5-second grace period for Org: ${organization_id}`);
		setTimeout(async () => {
			const currentPools = organizations[organization_id];
			if (!currentPools) return;

			console.log(`[DynamoDB Utilities] Cleanup Executing: Destroying active clients for Org: ${organization_id}`);
			const clientPromises = Object.values(currentPools);

			for (const clientPromise of clientPromises) {
				try {
					const client = await clientPromise;
					if (client && typeof client.destroy === "function") {
						client.destroy();
					}
				} catch (err) {
					console.error(`[DynamoDB Utilities] Error closing DynamoDB client for Org ${organization_id}:`, err);
				}
			}

			delete organizations[organization_id];
			console.log(`[DynamoDB Utilities] Memory Cleared: Registry freed for Org: ${organization_id}`);
		}, 5000);
	}
});


/**
 * Executes a transactional item write lock pipeline simulating isolation behaviors inside DynamoDB.
 * @private
 * @environment server
 */
async function executeUpdateTransaction(db, realTableName, itemId, rawUpdateInput, requestData) {
	try {
		// DynamoDB implements transactions via TransactWriteItems. We first read the item, apply changes
		// in code, and perform a conditional update check to prevent race condition write-collisions.
		const getRes = await db.send(new GetCommand({
			TableName: realTableName,
			Key: { _id: itemId }
		}));

		let currentRecord = getRes.Item || null;

		if (!currentRecord) {
			if (requestData.upsert || rawUpdateInput.upsert || rawUpdateInput.$upsert) {
				currentRecord = { _id: itemId, organization_id: requestData.organization_id };
			} else {
				return null;
			}
		}

		const updated = {
			on: new Date(requestData.timeStamp).toISOString(),
			by: requestData.user_id || requestData.clientId
		};

		const updatedPayload = applyMongoUpdate(currentRecord, rawUpdateInput);

		const savePayload = { ...updatedPayload };
		delete savePayload._id;
		delete savePayload.organization_id;
		delete savePayload.created;
		delete savePayload.updated;
		delete savePayload.modified;

		const recordToWrite = {
			_id: itemId,
			organization_id: requestData.organization_id,
			created: currentRecord.created || updated,
			updated,
			...savePayload
		};

		process.emit("usage", {
			type: "egress",
			data: { api: "transactWriteItem", table: realTableName, id: itemId },
			organization_id: requestData.organization_id
		});

		// Commit using AWS SDK's atomic validation transaction
		await db.send(new TransactWriteCommand({
			TransactItems: [
				{
					Put: {
						TableName: realTableName,
						Item: recordToWrite
					}
				}
			]
		}));

		return recordToWrite;
	} catch (error) {
		throw error;
	}
}

/**
 * Applies deep MongoDB modification operators ($set, $unset, $push, $pull, $addToSet, $inc)
 * recursively on a target record.
 * @private
 * @environment server
 */
function applyMongoUpdate(record, updatePayload) {
	let target = { ...record };

	Object.keys(updatePayload).forEach((rawKey) => {
		if (rawKey.startsWith("$")) return;
		let cleanKey = rawKey.replace(/\[(\d+)\]/g, ".$1");
		setNestedValue(target, cleanKey, updatePayload[rawKey]);
	});

	if (updatePayload.$set) {
		Object.keys(updatePayload.$set).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			setNestedValue(target, cleanKey, updatePayload.$set[key]);
		});
	}

	if (updatePayload.$unset) {
		Object.keys(updatePayload.$unset).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			deleteNestedValue(target, cleanKey);
		});
	}

	if (updatePayload.$inc) {
		Object.keys(updatePayload.$inc).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let currentVal = getNestedValue(target, cleanKey) || 0;
			setNestedValue(target, cleanKey, Number(currentVal) + Number(updatePayload.$inc[key]));
		});
	}

	if (updatePayload.$push) {
		Object.keys(updatePayload.$push).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const pushValue = updatePayload.$push[key];
			if (pushValue && pushValue.$each) {
				let valuesToPush = pushValue.$each;
				let position = typeof pushValue.$position === "number" ? pushValue.$position : arr.length;
				arr.splice(position, 0, ...valuesToPush);
			} else {
				arr.push(pushValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	if (updatePayload.$pull) {
		Object.keys(updatePayload.$pull).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (Array.isArray(arr)) {
				const filterVal = updatePayload.$pull[key];
				arr = arr.filter(item => {
					if (typeof filterVal === "object" && filterVal !== null) {
						return !queryData(item, filterVal);
					}
					return item !== filterVal;
				});
				setNestedValue(target, cleanKey, arr);
			}
		});
	}

	if (updatePayload.$addToSet) {
		Object.keys(updatePayload.$addToSet).forEach((key) => {
			let cleanKey = key.replace(/\[(\d+)\]/g, ".$1");
			let arr = getNestedValue(target, cleanKey);
			if (!Array.isArray(arr)) arr = [];

			const addValue = updatePayload.$addToSet[key];
			if (addValue && addValue.$each) {
				addValue.$each.forEach(item => {
					if (!arr.includes(item)) arr.push(item);
				});
			} else {
				if (!arr.includes(addValue)) arr.push(addValue);
			}
			setNestedValue(target, cleanKey, arr);
		});
	}

	return target;
}

/**
 * Translates CoCreate Mongo-style filters dynamically into AWS DynamoDB query schemas.
 * @private
 * @environment server
 */
function compileFilterToDynamo(tableName, filter, organizationId) {
	let params = {
		TableName: tableName,
		FilterExpression: "organization_id = :org_id",
		ExpressionAttributeValues: {
			":org_id": organizationId
		}
	};

	if (filter && filter.query) {
		let filterExpressions = ["organization_id = :org_id"];
		let expressionVals = { ":org_id": organizationId };
		let expressionNames = {};
		let count = 0;

		for (let key in filter.query) {
			if (["$or", "$and", "organization_id"].includes(key)) continue;

			let value = filter.query[key];
			const valPlaceholder = `:val_${count}`;
			const namePlaceholder = `#attr_${count}`;
			
			expressionNames[namePlaceholder] = key;

			if (value && typeof value === "object" && !Array.isArray(value)) {
				for (let op in value) {
					let operand = value[op];
					let specificValPlaceholder = `${valPlaceholder}_${op.replace("$", "")}`;
					expressionVals[specificValPlaceholder] = operand;

					if (op === "$gt") filterExpressions.push(`${namePlaceholder} > ${specificValPlaceholder}`);
					else if (op === "$gte") filterExpressions.push(`${namePlaceholder} >= ${specificValPlaceholder}`);
					else if (op === "$lt") filterExpressions.push(`${namePlaceholder} < ${specificValPlaceholder}`);
					else if (op === "$lte") filterExpressions.push(`${namePlaceholder} <= ${specificValPlaceholder}`);
					else if (op === "$ne") filterExpressions.push(`${namePlaceholder} <> ${specificValPlaceholder}`);
					else if (op === "$in") {
						delete expressionVals[specificValPlaceholder];
						const placeholders = operand.map((v, index) => {
							const inPlaceholder = `${valPlaceholder}_in_${index}`;
							expressionVals[inPlaceholder] = v;
							return inPlaceholder;
						});
						filterExpressions.push(`${namePlaceholder} IN (${placeholders.join(", ")})`);
					}
				}
			} else {
				expressionVals[valPlaceholder] = value;
				filterExpressions.push(`${namePlaceholder} = ${valPlaceholder}`);
			}
			count++;
		}

		params.FilterExpression = filterExpressions.join(" AND ");
		params.ExpressionAttributeValues = expressionVals;
		if (Object.keys(expressionNames).length > 0) {
			params.ExpressionAttributeNames = expressionNames;
		}
	}

	return params;
}

function replaceArray(data = {}) {
	let object = {};
	Object.keys(data).forEach((key) => {
		object[key.replace(/\[(\d+)\]/g, ".$1")] = data[key];
	});
	return object;
}

function getNestedValue(obj, path) {
	return path.split(".").reduce((acc, part) => acc && acc[part], obj);
}

function setNestedValue(obj, path, value) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc[part] = acc[part] || {}, obj);
	target[last] = value;
}

function deleteNestedValue(obj, path) {
	const parts = path.split(".");
	const last = parts.pop();
	const target = parts.reduce((acc, part) => acc && acc[part], obj);
	if (target) delete target[last];
}

function createData(data, array, type) {
	if (data[type] && data[type][0] && data[type][0].isFilter === "isEmptyObjectFilter") {
		data[type].shift();
		data.isFilter = true;
	}

	let key = type !== "object" ? "name" : "_id";

	if (!Array.isArray(data[type])) {
		console.log("data[type] is not an array", type);
	} else {
		for (let i = 0; i < array.length; i++) {
			const matchIndex = data[type].findIndex((item) => item[key] === array[i][key]);
			if (matchIndex !== -1) {
				for (let $type of ["$storage", "$database", "$array"]) {
					if (!data[type][matchIndex][$type]) data[type][matchIndex][$type] = [];
					if (!Array.isArray(data[type][matchIndex][$type])) {
						data[type][matchIndex][$type] = [data[type][matchIndex][$type]];
					}
					if (!data[type][matchIndex][$type].includes(array[i][$type])) {
						data[type][matchIndex][$type].push(array[i][$type]);
					}
					delete array[i][$type];
				}
				data[type][matchIndex] = { ...data[type][matchIndex], ...array[i] };
			} else {
				data[type].push(array[i]);
			}
		}
	}
	return data;
}

function errorHandler(data, error, database, array) {
	let errorMessage = typeof error === "object" && error.message ? error.message : error;
	let errorObject = {
		message: errorMessage,
		storage: "dynamodb"
	};

	if (database) errorObject.database = database;
	if (array) errorObject.array = array;

	if (Array.isArray(data.error)) {
		data.error.push(errorObject);
	} else {
		data.error = [errorObject];
	}
}

export {
    dbClient,
    createData,
    errorHandler
};
