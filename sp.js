// Generate a UUID
let sqlText = `SELECT UUID_STRING()`
let rs = snowflake.createStatement({ sqlText }).execute()
rs.next()
let callID = rs.getColumnValue(1)

// Generate table name
const tableName = `webhook-${callID}`

// Drop and create the calls table
sqlText = `CREATE OR REPLACE TRANSIENT TABLE "${tableName}" (ID VARCHAR, URL VARCHAR, METHOD VARCHAR, PAYLOAD VARCHAR)`
snowflake.createStatement({ sqlText }).execute()

// Insert a row for the webhook call
sqlText = `insert into "${tableName}" (ID, URL, METHOD, PAYLOAD) values (:1, :2, :3, :4)`
snowflake.createStatement({ sqlText, binds: [callID, URL, METHOD, PAYLOAD] }).execute()

// Dump the table out to S3 (using a stage, obvs)
sqlText = `copy into @webhook_calls/request/${callID} from (select object_construct('id', ID, 'url', URL, 'method', METHOD, 'payload', PAYLOAD) from "${tableName}")`
snowflake.createStatement({ sqlText }).execute()

// Poll for the response JSON file to appear in S3
const sleepMS = 50
const timeoutMS = 15000
let found = false
let start = new Date().getTime()
let response = null
do {

  // Wait
  sqlText = `call system$wait(${sleepMS}, 'MILLISECONDS')`
  snowflake.createStatement({ sqlText }).execute()

  // Check for the response in the stage
  sqlText = `select $1 from @webhook_calls/response/${callID}`
  let rs = snowflake.createStatement({ sqlText }).execute()
  found = rs.next()
  if(found) response = rs.getColumnValue(1)

} while(!found && new Date().getTime() < start + timeoutMS)

// Drop the transient table
sqlText = `DROP TABLE IF EXISTS "${tableName}"`
snowflake.createStatement({ sqlText }).execute()

// Return
return response
