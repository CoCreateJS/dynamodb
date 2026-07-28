import { 
    dbClient, 
    createData,
    errorHandler 
} from "./utilities.js";

/**
 * "database" operations mapped to DynamoDB logical grouping names.
 * DynamoDB is serverless and works globally on an AWS Region basis, so we emulate schemas.
 */
function database(method, data) {
    const storageName = data.storageConfig?.name;
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

export default database