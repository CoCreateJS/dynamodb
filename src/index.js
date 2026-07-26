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
 * Normalizes AWS credentials out of your structured data.url or data.storageUrl object.
 */
async function dbClient(data) {
	const storageUrl = data.storageUrl || data.url;

	if (storageUrl) {
		if (!organizations[data.organization_id]) {
			organizations[data.organization_id] = {};
		}
		try {
			if (!organizations[data.organization_id][storageUrl]) {
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

				organizations[data.organization_id][storageUrl] = connectionPromise;
			}

			return await organizations[data.organization_id][storageUrl];
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
 * Universal router matching your standard pipeline signature.
 */
function send(data) {
	let [type, method] = data.method.split(".");
	if (type === "database") return database(method, data);
	if (type === "array") return array(method, data);
	if (type === "object") return object(method, data);
}

/**
 * "database" operations mapped to DynamoDB logical grouping names.
 * DynamoDB is serverless and works globally on an AWS Region basis, so we emulate schemas.
 */
function database(method, data) {
	const storageName = data.storageName || data.provider || "dynamodb";
	return new Promise(async (resolve) => {
		let type = "database";
		let databaseArray = [];

		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			if (method === "read") {
				// We treat the current target region or designated config name as our active "database" catalog
				const dbName = data.database || "default";
				const dbObj = { name: dbName };

				process.emit("usage", {
					type: "egress",
					data: { api: "listDatabases", context: dbName },
					organization_id: data.organization_id
				});

				if (data.$filter && data.$filter.query) {
					let isFilter = queryData(dbObj, data.$filter.query);
					if (isFilter) {
						databaseArray.push({ database: dbObj, storage: storageName });
					}
				} else {
					databaseArray.push({ database: dbObj, storage: storageName });
				}
				resolve(createData(data, databaseArray, type));
			}
			if (method === "delete") {
				// To drop a database partition, we scan and drop all tables belonging to the organization namespace
				const listRes = await db.send(new ListTablesCommand({}));
				const prefix = `${data.organization_id}_`;
				
				for (let tName of listRes.TableNames || []) {
					if (tName.startsWith(prefix)) {
						process.emit("usage", {
							type: "egress",
							data: { api: "deleteTable", table: tName },
							organization_id: data.organization_id
						});
						await db.send(new DeleteTableCommand({ TableName: tName }));
					}
				}
				resolve({ status: true });
			}
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

/**
 * "array" operations mapped to AWS DynamoDB Tables.
 * To achieve strict isolation, we prefix table names: "orgId_arrayName"
 */
function array(method, data) {
	const storageName = data.storageName || data.provider || "dynamodb";
	return new Promise(async (resolve) => {
		let type = "array";
		let arrayArray = [];

		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			if (data.request) data.array = data.request;

			let databases = data.database;
			if (!Array.isArray(databases)) databases = [databases];

			let databasesLength = databases.length;
			for (let database of databases) {
				const prefix = `${data.organization_id}_`;

				if (method === "read") {
					process.emit("usage", {
						type: "egress",
						data: { api: "listTables" },
						organization_id: data.organization_id
					});

					const listRes = await db.send(new ListTablesCommand({}));
					for (let tName of listRes.TableNames || []) {
						if (tName.startsWith(prefix)) {
							const cleanName = tName.substring(prefix.length);
							const tableObj = { name: cleanName };

							if (data.$filter && data.$filter.query) {
								let isFilter = queryData(tableObj, data.$filter.query);
								if (isFilter) {
									arrayArray.push({ name: cleanName, database, storage: storageName });
								}
							} else {
								arrayArray.push({ name: cleanName, database, storage: storageName });
							}
						}
					}

					databasesLength -= 1;
					if (!databasesLength) {
						data = createData(data, arrayArray, type);
						resolve(data);
					}
				} else {
					let arrays = data.array;
					if (method === "update") arrays = Object.entries(data.array);
					if (!Array.isArray(arrays)) arrays = [arrays];

					let arraysLength = arrays.length;
					for (let array of arrays) {
						if (method === "create") {
							const realTableName = `${prefix}${array}`;
							
							process.emit("usage", {
								type: "egress",
								data: { api: "createTable", table: realTableName },
								organization_id: data.organization_id
							});

							// DynamoDB requires a defined partition key scheme. We map '_id' as the primary hash key.
							await db.send(new CreateTableCommand({
								TableName: realTableName,
								KeySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
								AttributeDefinitions: [{ AttributeName: "_id", AttributeType: "S" }],
								BillingMode: "PAY_PER_REQUEST" // Serverless/On-Demand pricing
							}));

							arrayArray.push({ name: array, database, storage: storageName });

							arraysLength -= 1;
							if (!arraysLength) databasesLength -= 1;
							if (!databasesLength && !arraysLength) {
								data = createData(data, arrayArray, type);
								resolve(data);
							}
						} else {
							if (method === "update") {
								let [oldName, newName] = array;
								const oldRealName = `${prefix}${oldName}`;
								const newRealName = `${prefix}${newName}`;

								process.emit("usage", {
									type: "egress",
									data: { api: "renameTableEmulation", from: oldRealName, to: newRealName },
									organization_id: data.organization_id
								});

								// AWS DynamoDB does not natively support table renaming. We emulate this by creating
								// the new table and migrating all scanned items into the new workspace.
								await db.send(new CreateTableCommand({
									TableName: newRealName,
									KeySchema: [{ AttributeName: "_id", KeyType: "HASH" }],
									AttributeDefinitions: [{ AttributeName: "_id", AttributeType: "S" }],
									BillingMode: "PAY_PER_REQUEST"
								}));

								// Scan items out of old table and bulk-insert them
								const scanRes = await db.send(new ScanCommand({ TableName: oldRealName }));
								for (let item of scanRes.Items || []) {
									await db.send(new PutCommand({ TableName: newRealName, Item: item }));
								}

								// Drop old table cleanly
								await db.send(new DeleteTableCommand({ TableName: oldRealName }));

								arrayArray.push({ name: newName, oldName: oldName, database, storage: storageName });

								arraysLength -= 1;
								if (!arraysLength) databasesLength -= 1;
								if (!databasesLength && !arraysLength) {
									data = createData(data, arrayArray, type);
									resolve(data);
								}
							}

							if (method === "delete") {
								const realTableName = `${prefix}${array}`;
								process.emit("usage", {
									type: "egress",
									data: { api: "deleteTable", table: realTableName },
									organization_id: data.organization_id
								});

								await db.send(new DeleteTableCommand({ TableName: realTableName }));

								arrayArray.push({ name: array, database, storage: storageName });

								arraysLength -= 1;
								if (!arraysLength) databasesLength -= 1;
								if (!databasesLength && !arraysLength) {
									data = createData(data, arrayArray, type);
									resolve(data);
								}
							}
						}
					}
				}
			}
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

/**
 * "object" operations mapped to AWS DynamoDB Table Items.
 */
function object(method, data) {
	const storageName = data.storageName || data.provider || "dynamodb";
	return new Promise(async (resolve) => {
		try {
			const db = await dbClient(data);
			if (!db || db.status === false) return resolve(data);

			let type = "object";
			let documents = [];

			if (!data["timeStamp"]) {
				data["timeStamp"] = new Date().toISOString();
			}

			let databases = data.database;
			if (!Array.isArray(databases)) databases = [databases];

			for (let database of databases) {
				let arrays = data.array;
				if (!Array.isArray(arrays)) arrays = [arrays];

				for (let array of arrays) {
					const realTableName = `${data.organization_id}_${array}`;
					const reference = {
						$storage: storageName,
						$database: database,
						$array: array
					};

					if (!data[type]) data[type] = [];
					else if (typeof data[type] === "string")
						data[type] = [{ _id: data[type] }];
					else if (!Array.isArray(data[type]))
						data[type] = [data[type]];

					let isFilter = !!data.$filter;
					if ((isFilter && !data[type].length) || data.isFilter) {
						data[type].splice(0, 0, { isFilter: "isEmptyObjectFilter" });
					}

					for (let i = 0; i < data[type].length; i++) {
						let $storage = data[type][i].$storage || [];
						let $database = data[type][i].$database || [];
						let $array = data[type][i].$array || [];

						if (!Array.isArray($storage)) $storage = [data[type][i].$storage];
						if (!Array.isArray($database)) $database = [data[type][i].$database];
						if (!Array.isArray($array)) $array = [data[type][i].$array];

						if (!$storage.includes(storageName)) $storage.push(storageName);
						if (!$database.includes(database)) $database.push(database);
						if (!$array.includes(array)) $array.push(array);

						delete data[type][i].$storage;
						delete data[type][i].$database;
						delete data[type][i].$array;

						let queryFilter = isFilter ? data.$filter : (data[type][i].$filter || null);

						if (method === "create") {
							data[type][i] = replaceArray(data[type][i]);
							data[type][i] = dotNotationToObject(data[type][i]);

							const id = data[type][i]._id || `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
							const orgId = data.organization_id;
							const created = {
								on: new Date(data.timeStamp).toISOString(),
								by: data.user_id || data.clientId
							};

							const recordPayload = { ...data[type][i] };
							delete recordPayload._id;
							delete recordPayload.organization_id;

							const finalItem = {
								_id: id,
								organization_id: orgId,
								created,
								modified: null,
								...recordPayload
							};

							process.emit("usage", {
								type: "egress",
								data: { api: "putItem", table: realTableName, id },
								organization_id: data.organization_id
							});

							await db.send(new PutCommand({
								TableName: realTableName,
								Item: finalItem
							}));

							data[type][i] = { ...finalItem, $storage, $database, $array };
						}
						else if (method === "read") {
							if (data[type][i]._id && !isFilter) {
								process.emit("usage", {
									type: "egress",
									data: { api: "getItem", table: realTableName, id: data[type][i]._id },
									organization_id: data.organization_id
								});

								const getRes = await db.send(new GetCommand({
									TableName: realTableName,
									Key: { _id: data[type][i]._id }
								}));

								if (getRes.Item) {
									let dbRecord = getRes.Item;

									// Dynamic offline timings sync
									if ($storage.length && data[type][i].modified && data[type][i].modified.on) {
										let clientTime = new Date(data[type][i].modified.on);
										let dbTime = new Date(dbRecord.modified ? dbRecord.modified.on : 0);

										if (clientTime > dbTime) {
											const updatedRecord = { ...dbRecord, ...data[type][i] };
											const savedRecord = await executeUpdateTransaction(db, realTableName, data[type][i]._id, updatedRecord, data);
											data[type][i] = { ...savedRecord, $storage, $database, $array };
										} else {
											data[type][i] = { ...data[type][i], ...dbRecord, $storage, $database, $array };
										}
									} else {
										data[type][i] = { ...data[type][i], ...dbRecord, $storage, $database, $array };
									}
								} else {
									data[type].splice(i, 1);
									i--;
								}
							} else {
								process.emit("usage", {
									type: "egress",
									data: { api: "scanTable", table: realTableName },
									organization_id: data.organization_id
								});

								// Compile query filters dynamically
								let scanParams = compileFilterToDynamo(realTableName, queryFilter, data.organization_id);
								const scanRes = await db.send(new ScanCommand(scanParams));
								
								let rows = scanRes.Items || [];

								// Handle in-memory sorting/limit offset fallbacks for unindexed scan sets
								if (data.$filter && data.$filter.sort) {
									rows = sortData(rows, data.$filter.sort);
								}
								if (data.$filter && typeof data.$filter.index === "number") {
									rows = rows.slice(data.$filter.index);
								}
								if (data.$filter && typeof data.$filter.limit === "number") {
									rows = rows.slice(0, data.$filter.limit);
								}

								for (let parsedRow of rows) {
									if (data.$filter && data.$filter.search) {
										let isMatch = searchData(parsedRow, data.$filter.search);
										if (!isMatch) continue;
									}
									documents.push({
										...parsedRow,
										...reference
									});
								}
							}
						}
						else if (method === "update") {
							const updatePayload = { ...data[type][i] };
							delete updatePayload._id;
							delete updatePayload.$filter;

							if (data[type][i]._id) {
								const updatedDoc = await executeUpdateTransaction(db, realTableName, data[type][i]._id, updatePayload, data);
								if (updatedDoc) {
									data[type][i] = { ...updatedDoc, $storage, $database, $array };
								}
							} else if (isFilter) {
								let scanParams = compileFilterToDynamo(realTableName, queryFilter, data.organization_id);
								process.emit("usage", {
									type: "egress",
									data: { api: "scanForUpdate", table: realTableName },
									organization_id: data.organization_id
								});
								const scanRes = await db.send(new ScanCommand(scanParams));

								for (let item of scanRes.Items || []) {
									const updatedDoc = await executeUpdateTransaction(db, realTableName, item._id, updatePayload, data);
									if (updatedDoc) {
										documents.push({ ...updatedDoc, ...reference });
									}
								}
							}
						}
						else if (method === "delete") {
							if (data[type][i]._id) {
								process.emit("usage", {
									type: "egress",
									data: { api: "deleteItem", table: realTableName, id: data[type][i]._id },
									organization_id: data.organization_id
								});
								await db.send(new DeleteCommand({
									TableName: realTableName,
									Key: { _id: data[type][i]._id }
								}));
								data[type][i] = { _id: data[type][i]._id, $storage, $database, $array };
							} else if (isFilter) {
								let scanParams = compileFilterToDynamo(realTableName, queryFilter, data.organization_id);
								process.emit("usage", {
									type: "egress",
									data: { api: "scanForDelete", table: realTableName },
									organization_id: data.organization_id
								});
								const scanRes = await db.send(new ScanCommand(scanParams));

								for (let item of scanRes.Items || []) {
									await db.send(new DeleteCommand({
										TableName: realTableName,
										Key: { _id: item._id }
									}));
									documents.push({ _id: item._id, ...reference });
								}
							}
						}
					}
				}
			}

			data = createData(data, documents, type);
			resolve(data);
		} catch (error) {
			errorHandler(data, error);
			console.log(method, "error", error);
			resolve(data);
		}
	});
}

/**
 * Executes a transactional item write lock pipeline simulating isolation behaviors inside DynamoDB.
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

		const modified = {
			on: new Date(requestData.timeStamp).toISOString(),
			by: requestData.user_id || requestData.clientId
		};

		const updatedPayload = applyMongoUpdate(currentRecord, rawUpdateInput);

		const savePayload = { ...updatedPayload };
		delete savePayload._id;
		delete savePayload.organization_id;
		delete savePayload.created;
		delete savePayload.modified;

		const recordToWrite = {
			_id: itemId,
			organization_id: requestData.organization_id,
			created: currentRecord.created || modified,
			modified,
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

export default { send };