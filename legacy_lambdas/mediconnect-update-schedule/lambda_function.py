import json
import boto3
import datetime
from botocore.exceptions import ClientError

# 🟢 CONNECT TO DB
dynamodb = boto3.resource('dynamodb')
TABLE_NAME = "mediconnect-doctor-schedules"

def lambda_handler(event, context):
    # 🔒 STANDARD CORS HEADERS
    headers = {
        "Access-Control-Allow-Origin": "*", 
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,GET,POST"
    }

    try:
        # 1. Handle Pre-flight OPTIONS
        if event.get('httpMethod') == 'OPTIONS':
             return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps("OK")
            }

        table = dynamodb.Table(TABLE_NAME)
        http_method = event.get('httpMethod')

        # ---------------------------------------------------------
        # 🟢 OPTION A: GET REQUEST (Fetch Schedule + Timezone)
        # ---------------------------------------------------------
        if http_method == 'GET':
            params = event.get('queryStringParameters') or {}
            doctor_id = params.get('doctorId')

            if not doctor_id:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "Missing doctorId parameter"})
                }
            
            # Fetch from DynamoDB
            response = table.get_item(Key={'doctorId': doctor_id})
            item = response.get('Item', {})
            
            # If no timezone is set, default to UTC to prevent frontend errors
            if 'timezone' not in item:
                item['timezone'] = 'UTC'

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps(item)
            }

        # ---------------------------------------------------------
        # 🔴 OPTION B: POST REQUEST (Save Schedule + Timezone)
        # ---------------------------------------------------------
        elif http_method == 'POST':
            # Parse Body safely
            if 'body' in event:
                body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
            else:
                body = event or {}

            doctor_id = body.get('doctorId')
            weekly_schedule = body.get('schedule')
            # 🟢 NEW: Capture Timezone (Critical for international doctors)
            timezone = body.get('timezone', 'UTC') 

            if not doctor_id or not weekly_schedule:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "Missing doctorId or schedule data"})
                }

            # Update DynamoDB with Timezone info
            table.put_item(Item={
                'doctorId': doctor_id,
                'schedule': weekly_schedule,
                'timezone': timezone,
                'lastUpdated': str(datetime.datetime.now())
            })

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "message": "Schedule and Timezone updated successfully",
                    "savedTimezone": timezone
                })
            }

        else:
            return {
                "statusCode": 405,
                "headers": headers,
                "body": json.dumps({"error": f"Method {http_method} not allowed"})
            }

    except Exception as e:
        print(f"❌ Error: {str(e)}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": str(e)})
        }