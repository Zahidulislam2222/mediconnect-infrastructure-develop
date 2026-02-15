import boto3
import json
from botocore.exceptions import ClientError

def get_secret(secret_name, region_name="us-east-1"):
    """
    Retrieves a secret from AWS Secrets Manager.
    """
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name
    )

    try:
        get_secret_value_response = client.get_secret_value(
            SecretId=secret_name
        )
    except ClientError as e:
        # For debugging purposes (in production, log this securel)
        print(f"Error retrieving secret: {e}")
        raise e

    # Decrypts secret using the associated KMS key.
    if 'SecretString' in get_secret_value_response:
        secret = get_secret_value_response['SecretString']
        return json.loads(secret)
    else:
        # If binary data (rare for simple DB creds)
        return get_secret_value_response['SecretBinary']

# Usage Example:
# db_creds = get_secret("mediconnect/prod/db_credentials")
# print(db_creds['username'])