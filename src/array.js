import { 
    dbClient, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "array" operations mapped to AWS DynamoDB Tables.
 * To achieve strict isolation, we prefix table names: "orgId_arrayName"
 */
function array(method, data) {
    const storageName = data.storageConfig?.name;
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

                            if (data.filter && data.filter.query) {
                                let isFilter = queryData(tableObj, data.filter.query);
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

export default array