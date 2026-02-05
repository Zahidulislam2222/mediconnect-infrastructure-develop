import os
import boto3
import psycopg2
from azure.cosmos import CosmosClient, PartitionKey
import logging
import json

# Setup Audit Logging (HIPAA Requirement)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - AUDIT - %(message)s')
logger = logging.getLogger()

def get_ssm_param(param_name):
    ssm = boto3.client('ssm', region_name=os.environ['AWS_REGION'])
    return ssm.get_parameter(Name=param_name, WithDecryption=True)['Parameter']['Value']

def migrate_data():
    logger.info("🔒 STARTING SECURE MIGRATION JOB")
    
    # 1. AWS Source Connection (Implicit IAM Role)
    dynamodb = boto3.resource('dynamodb', region_name=os.environ['AWS_REGION'])
    
    # 2. GCP Destination Connection (SSL Required)
    logger.info("Connecting to GCP Cloud SQL...")
    try:
        conn = psycopg2.connect(
    host=get_ssm_param('/mediconnect/prod/gcp/sql/public_ip'),
    database=get_ssm_param('/mediconnect/prod/gcp/sql/db_name'),
    user="postgres",
    password=get_ssm_param('/mediconnect/prod/db/master_password'),
    sslmode='require' # We can keep 'require' now because GCP allows SSL without certs
)
        cur = conn.cursor()
    except Exception as e:
        logger.error(f"GCP Connection Failed: {e}")
        return

    # 3. Azure Destination Connection (TLS Required)
    logger.info("Connecting to Azure Cosmos DB...")
    try:
        az_client = CosmosClient(
            url=get_ssm_param('/mediconnect/prod/azure/cosmos/endpoint'),
            credential=get_ssm_param('/mediconnect/prod/azure/cosmos/primary_key')
        )
        # INDENT THIS LINE BELOW:
        az_db = az_client.get_database_client("mediconnect-db") 
    except Exception as e:
        logger.error(f"Azure Connection Failed: {e}")
        return

    # 4. MIGRATION LOGIC (Example: Doctors Table -> GCP)
    table = dynamodb.Table('mediconnect-doctors')
    scan = table.scan()
    items = scan['Items']
    
    logger.info(f"Transferring {len(items)} Doctor records to GCP...")
    
    create_table_query = """
    CREATE TABLE IF NOT EXISTS doctors (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        specialization VARCHAR(255),
        data JSONB
    );
    """
    cur.execute(create_table_query)
    
    for item in items:
        # Transform DynamoDB JSON to Postgres
        cur.execute(
            "INSERT INTO doctors (id, name, specialization, data) VALUES (%s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
            (item['doctorId'], item.get('name', 'Unknown'), item.get('specialization', 'General'), json.dumps(item)) # <--- CHANGE str(item) TO json.dumps(item)
        )
    
    conn.commit()
    logger.info("✅ Relational Data Transfer Complete.")

    # 5. Cleanup
    cur.close()
    conn.close()
    logger.info("🔒 MIGRATION JOB FINISHED SUCCESSFULLY")

if __name__ == "__main__":
    migrate_data()