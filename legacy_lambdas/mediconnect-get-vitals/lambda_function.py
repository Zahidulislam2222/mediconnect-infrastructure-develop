import json
import boto3
from boto3.dynamodb.conditions import Key
from decimal import Decimal

# 1. Initialize DynamoDB
# We access the table where IoT Core is saving the data
dynamodb = boto3.resource('dynamodb')
table = dynamodb.Table('mediconnect-iot-vitals')

# Helper Class: Fixes the crash when DynamoDB returns Numbers as 'Decimal' objects
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def lambda_handler(event, context):
    # 2. CORS Headers (CRITICAL: Required for React Frontend)
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
    }

    try:
        # 3. Parse Query Parameters
        # Example URL: /vitals?patientId=p-123&limit=20
        params = event.get('queryStringParameters', {}) or {}
        
        patient_id = params.get('patientId')
        limit = int(params.get('limit', 20))  # Default to last 20 readings if not specified

        # Validation
        if not patient_id:
            return {
                'statusCode': 400,
                'headers': headers,
                'body': json.dumps({'error': 'Missing required parameter: patientId'})
            }

        # 4. Query Database
        # KeyCondition: Match the patientId
        # ScanIndexForward=False: Sort by Timestamp DESCENDING (Newest first)
        response = table.query(
            KeyConditionExpression=Key('patientId').eq(patient_id),
            ScanIndexForward=False, 
            Limit=limit
        )

        items = response.get('Items', [])

        # 5. Return Data to Frontend
        return {
            'statusCode': 200,
            'headers': headers,
            'body': json.dumps(items, cls=DecimalEncoder)
        }

    except Exception as e:
        print(f"Server Error: {str(e)}")
        return {
            'statusCode': 500,
            'headers': headers,
            'body': json.dumps({'error': 'Internal Server Error', 'details': str(e)})
        }