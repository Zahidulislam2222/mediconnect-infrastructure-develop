import json
import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config

# 🟢 CONNECT TO DYNAMODB AND S3
dynamodb = boto3.resource('dynamodb')
s3 = boto3.client(
    's3', 
    region_name='us-east-1', 
    config=Config(signature_version='s3v4')
)

TABLE_NAME = "mediconnect-doctors"
BUCKET_NAME = "mediconnect-identity-verification"

def lambda_handler(event, context):
    # 🔒 CORS HEADERS
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,GET"
    }
    
    try:
        table = dynamodb.Table(TABLE_NAME)
        
        # 1. Scan the DOCTORS table
        response = table.scan()
        items = response.get('Items', [])
        
        doctors_list = []
        
        # 2. Loop through doctors and SIGN their avatar images
        for doc in items:
            if doc.get('role') == 'doctor':
                
                # 🟢 NEW SECURITY LOGIC: Generate Presigned URL
                if 'avatar' in doc and doc['avatar']:
                    # Check if it's a File Path (not a public URL)
                    if not doc['avatar'].startswith("http"):
                        try:
                            secure_url = s3.generate_presigned_url(
                                'get_object',
                                Params={'Bucket': BUCKET_NAME, 'Key': doc['avatar']},
                                ExpiresIn=3600  # Link valid for 1 hour
                            )
                            doc['avatar'] = secure_url
                        except Exception as e:
                            print(f"Error signing URL for doctor {doc.get('doctorId')}: {e}")
                
                doctors_list.append(doc)

        # 3. Return Clean List
        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({
                "count": len(doctors_list),
                "doctors": doctors_list
            }, default=str)
        }

    except Exception as e:
        print(f"ERROR: {str(e)}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": str(e)})
        }