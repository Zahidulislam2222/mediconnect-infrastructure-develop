from google.cloud import bigquery
from google.oauth2 import service_account
import json
import datetime
import boto3

# Initialize Secrets Manager Client
secrets_client = boto3.client('secretsmanager', region_name='us-east-1')

def get_gcp_credentials():
    """Fetches the GCP JSON Key from AWS Secrets Manager."""
    try:
        response = secrets_client.get_secret_value(SecretId='mediconnect/gcp/bigquery_key')
        if 'SecretString' in response:
            return json.loads(response['SecretString'])
    except Exception as e:
        print(f"❌ Failed to retrieve GCP credentials: {e}")
        return None

def record_doctor_event(doctor_id, event_type, status):
    """Inserts a row into BigQuery for analytics."""
    print(f"📊 Logging event to BigQuery: {event_type}...")
    
    # 1. Get Credentials
    creds_dict = get_gcp_credentials()
    if not creds_dict:
        return False

    # 2. Authenticate & Insert
    try:
        credentials = service_account.Credentials.from_service_account_info(creds_dict)
        client = bigquery.Client(credentials=credentials, project=creds_dict['project_id'])
        
        table_id = f"{creds_dict['project_id']}.mediconnect_analytics.doctor_onboarding_logs"
        
        rows_to_insert = [{
            "doctor_id": doctor_id,
            "event_type": event_type,
            "status": status,
            "timestamp": datetime.datetime.utcnow().isoformat()
        }]

        errors = client.insert_rows_json(table_id, rows_to_insert)
        if errors == []:
            print("✅ Analytics sent to BigQuery.")
            return True
        else:
            print(f"⚠️ BigQuery Errors: {errors}")
            return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False