import json
import boto3
import os
import datetime
import logging
from botocore.config import Config

# --- CONFIG ---
logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb')
s3 = boto3.client(
    's3', 
    region_name='us-east-1', 
    config=Config(signature_version='s3v4')
)
DYNAMO_TABLE = os.environ.get('DYNAMO_TABLE', 'mediconnect-patients')
BUCKET_NAME = "mediconnect-identity-verification"

# 🔒 HEADERS
HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT"
}

def lambda_handler(event, context):
    response_log = []
    
    try:
        # 🟢 1. HANDLE OPTIONS (Pre-flight)
        if event.get('httpMethod') == 'OPTIONS':
             return { 'statusCode': 200, 'headers': HEADERS, 'body': '' }

      # 🟢 2. HANDLE GET REQUEST
        if event.get('httpMethod') == 'GET':
            params = event.get('queryStringParameters') or {}
            
            # --- A. ANALYTICS MODE (Demographics) ---
            if params.get('type') == 'demographics':
                try:
                    table = dynamodb.Table(DYNAMO_TABLE)
                    # Optimization: Only fetch DOB and Role
                    response = table.scan(
                        ProjectionExpression='dob, #r',
                        ExpressionAttributeNames={'#r': 'role'}
                    )
                    items = response.get('Items', [])
                    
                    age_groups = {'18-30': 0, '31-50': 0, '51-70': 0, '70+': 0}
                    patient_count = 0
                    current_year = datetime.datetime.now().year

                    for item in items:
                        # Filter for patients only
                        if item.get('role') == 'patient' and item.get('dob'):
                            patient_count += 1
                            try:
                                # Parse DOB (assuming YYYY-MM-DD)
                                birth_year = int(item['dob'].split('-')[0])
                                age = current_year - birth_year
                                
                                if age <= 30: age_groups['18-30'] += 1
                                elif age <= 50: age_groups['31-50'] += 1
                                elif age <= 70: age_groups['51-70'] += 1
                                else: age_groups['70+'] += 1
                            except:
                                continue # Skip invalid dates

                    demographic_data = [{"name": k, "value": v} for k, v in age_groups.items()]
                    
                    return {
                        "statusCode": 200,
                        "headers": HEADERS,
                        "body": json.dumps({
                            "demographicData": demographic_data,
                            "totalPatients": patient_count
                        })
                    }
                except Exception as e:
                    logger.error(f"Demographics Error: {str(e)}")
                    return { "statusCode": 200, "headers": HEADERS, "body": json.dumps({"demographicData": []}) }

            # --- B. PROFILE MODE (Fetch Single User) ---
            user_id = params.get('id') or params.get('patientId')
            
            if not user_id:
                return { "statusCode": 400, "headers": HEADERS, "body": json.dumps({"error": "Missing id"}) }
            
            table = dynamodb.Table(DYNAMO_TABLE)
            response = table.get_item(Key={'patientId': user_id})
            
            if 'Item' in response:
                item = response['Item']
                
                # 🟢 NEW: Generate Secure Link for Avatar
                if 'avatar' in item and item['avatar']:
                    # Only sign if it is a Path (does not start with http)
                    if not item['avatar'].startswith('http'):
                        try:
                            item['avatar'] = s3.generate_presigned_url(
                                'get_object',
                                Params={'Bucket': BUCKET_NAME, 'Key': item['avatar']},
                                ExpiresIn=3600 # Link valid for 1 hour
                            )
                        except Exception as e:
                            logger.error(f"S3 Signing Error: {str(e)}")

                return { "statusCode": 200, "headers": HEADERS, "body": json.dumps(item, default=str) }
            else:
                return { "statusCode": 404, "headers": HEADERS, "body": json.dumps({"error": "Patient not found"}) }

        # 🟢 3. HANDLE PUT REQUEST (⚠️ NEW: SAFE UPDATE LOGIC)
        # ---------------------------------------------------------
        if event.get('httpMethod') == 'PUT':
            if 'body' in event:
                body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
            else:
                body = event

            user_id = body.get('userId') or body.get('patientId')
            if not user_id:
                return { "statusCode": 400, "headers": HEADERS, "body": json.dumps({"error": "Missing userId"}) }

            # ✅ FIXED SYNTAX ERROR HERE
            allowed_updates = ['name', 'avatar', 'phone', 'address', 'preferences', 'dob', 'isEmailVerified']
            
            update_expression_parts = []
            expression_attribute_names = {}
            expression_attribute_values = {}

            # Dynamically build the update query
            for field in allowed_updates:
                if field in body:
                    # Construct: #field = :field
                    update_expression_parts.append(f"#{field} = :{field}")
                    expression_attribute_names[f"#{field}"] = field
                    expression_attribute_values[f":{field}"] = body[field]

            if not update_expression_parts:
                return { "statusCode": 400, "headers": HEADERS, "body": json.dumps({"error": "No valid fields provided for update"}) }

            # Add timestamp update
            update_expression_parts.append("#updatedAt = :updatedAt")
            expression_attribute_names["#updatedAt"] = "updatedAt"
            expression_attribute_values[":updatedAt"] = str(datetime.datetime.now())

            update_expression_str = "SET " + ", ".join(update_expression_parts)

            try:
                table = dynamodb.Table(DYNAMO_TABLE)
                response = table.update_item(
                    Key={'patientId': user_id},
                    UpdateExpression=update_expression_str,
                    ExpressionAttributeNames=expression_attribute_names,
                    ExpressionAttributeValues=expression_attribute_values,
                    ReturnValues="ALL_NEW" # Returns the updated profile
                )
                
                return {
                    "statusCode": 200,
                    "headers": HEADERS,
                    "body": json.dumps({
                        "message": "Profile updated successfully",
                        "profile": response.get('Attributes')
                    }, default=str)
                }
            except Exception as e:
                logger.error(f"Update Failed: {str(e)}")
                return { "statusCode": 500, "headers": HEADERS, "body": json.dumps({"error": f"Update failed: {str(e)}"}) }

        # 🟢 4. HANDLE POST REQUEST (Creation Logic)
        # ---------------------------------------------------------
        if event.get('httpMethod') == 'POST':
            if 'body' in event:
                body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
            else:
                body = event

            user_id = body.get('userId')
            email = body.get('email')
            name = body.get('name')
            role = body.get('role', 'patient')
            dob = body.get('dob', None)
            
            if not user_id or not email:
                return {"statusCode": 400, "headers": HEADERS, "body": json.dumps({"error": "Missing userId or email"})}

            timestamp = str(datetime.datetime.now())

            # --- WRITE TO DYNAMODB (PUT_ITEM - Overwrites everything) ---
            try:
                table = dynamodb.Table(DYNAMO_TABLE)
                table.put_item(Item={
                    'patientId': user_id,
                    'email': email,
                    'name': name,
                    'role': role,
                    'isEmailVerified': False,
                    'isIdentityVerified': False, 
                    'createdAt': timestamp,
                    'avatar': None,
                    'preferences': { "email": True, "sms": True } # Default prefs
                })
                response_log.append("DynamoDB: Success")
            except Exception as e:
                logger.error(f"DynamoDB Failed: {str(e)}")
                raise e

            return {
                "statusCode": 200,
                "headers": HEADERS,
                "body": json.dumps({
                    "message": "Patient Registration Processed",
                    "details": response_log
                })
            }

    except Exception as e:
        return {
            "statusCode": 500,
            "headers": HEADERS,
            "body": json.dumps(f"Server Error: {str(e)}")
        }