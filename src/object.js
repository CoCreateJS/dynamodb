import {
    ObjectId,
    dotNotationToObject,
    searchData,
    isValidDate
} from "@cocreate/utils";

import { 
    dbClient, 
    createFilter, 
    createData,
    errorHandler 
} from "./utilities.js";

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

export {object}