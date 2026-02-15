import json
import boto3
import datetime
from decimal import Decimal
from botocore.config import Config

# 🟢 CONNECT TO DATABASE
dynamodb = boto3.resource('dynamodb')
s3 = boto3.client(
    's3', 
    region_name='us-east-1', 
    config=Config(signature_version='s3v4')
)
TABLE_NAME = "mediconnect-doctors"
BUCKET_NAME = "mediconnect-identity-verification"

# --- HELPER: Fixes "Object of type Decimal is not JSON serializable" ---
class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super(DecimalEncoder, self).default(obj)

def lambda_handler(event, context):
    # 🔒 CORS HEADERS
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT" 
    }

    # Handle Pre-flight
    if event.get('httpMethod') == 'OPTIONS':
        return {"statusCode": 200, "headers": headers, "body": ""}

    try:
        method = event.get('httpMethod')
        table = dynamodb.Table(TABLE_NAME)

        # ======================================================
        # 🟢 GET METHOD (Fetch Profile)
        # ======================================================
        if method == 'GET':
            query_params = event.get('queryStringParameters') or {}
            doctor_id = query_params.get('id') or query_params.get('doctorId')

            if not doctor_id:
                return {
                    "statusCode": 400, 
                    "headers": headers, 
                    "body": json.dumps({"error": "Missing id parameter"})
                }

            response = table.get_item(Key={'doctorId': doctor_id})

            if 'Item' in response:
                item = response['Item']

                # 🟢 NEW: Sign the Image URL
                if 'avatar' in item and item['avatar'] and not item['avatar'].startswith('http'):
                    try:
                        item['avatar'] = s3.generate_presigned_url(
                            'get_object',
                            Params={'Bucket': BUCKET_NAME, 'Key': item['avatar']},
                            ExpiresIn=3600
                        )
                    except Exception as e:
                        print(f"S3 Signing Error: {str(e)}")

                return {
                    "statusCode": 200,
                    "headers": headers,
                    "body": json.dumps(item, cls=DecimalEncoder)
                }
            else:
                return {
                    "statusCode": 404, 
                    "headers": headers, 
                    "body": json.dumps({"error": "Doctor not found"})
                }

        # ======================================================
        # 🔵 POST METHOD (Register Doctor - Create New)
        # ======================================================
        if method == 'POST':
            if 'body' in event:
                body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
            else:
                body = event

            doctor_id = body.get('doctorId') or body.get('userId')
            email = body.get('email')
            name = body.get('name')
            
            # Defaults
            raw_role = body.get('role', 'doctor')
            role = 'doctor' if raw_role == 'provider' else raw_role
            specialization = body.get('specialization', 'General Practice')
            license_number = body.get('licenseNumber', 'PENDING_VERIFICATION')

            if not doctor_id or not email:
                return { 
                    "statusCode": 400, 
                    "headers": headers,
                    "body": json.dumps({"error": "Missing userId or email"}) 
                }
            
            table.put_item(Item={
                'doctorId': doctor_id,
                'email': email,
                'name': name,
                'specialization': specialization,
                'licenseNumber': license_number,
                'role': role,
                'createdAt': str(datetime.datetime.now()),
                'isEmailVerified': False,       
                'isIdentityVerified': False,    
                'isDiplomaAutoVerified': False, 
                'isOfficerApproved': False,     
                'verificationStatus': "UNVERIFIED" 
            })
            
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({"message": "Doctor profile created successfully"})
            }

        # ======================================================
        # 🟠 PUT METHOD (Update Profile)
        # ======================================================
        if method == 'PUT':
            if 'body' in event:
                body = json.loads(event['body']) if isinstance(event['body'], str) else event['body']
            else:
                body = event

            # Get ID
            doctor_id = body.get('doctorId') or body.get('userId') or body.get('id')

            if not doctor_id:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "Missing doctorId/userId for update"})
                }

            # ✅ FIX 1: Added 'isEmailVerified' to this list
            allowed_fields = [
                'name', 'phone', 'address', 'avatar', 'specialization', 
                'consultationFee', 'bio', 'preferences', 'isEmailVerified'
            ]
            
            update_parts = []
            expression_values = {}
            expression_names = {} 
            
            for field in allowed_fields:
                if field in body:
                    update_parts.append(f"#{field} = :{field}")
                    expression_values[f":{field}"] = body[field]
                    expression_names[f"#{field}"] = field

            if not update_parts:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "No valid fields provided for update"})
                }

            # ✅ FIX 2: Add UpdatedAt Timestamp
            update_parts.append("#updatedAt = :updatedAt")
            expression_names["#updatedAt"] = "updatedAt"
            expression_values[":updatedAt"] = str(datetime.datetime.now())

            # Join with commas
            update_expression = "SET " + ", ".join(update_parts)

            # Perform Update
            response = table.update_item(
                Key={'doctorId': doctor_id},
                UpdateExpression=update_expression,
                ExpressionAttributeValues=expression_values,
                ExpressionAttributeNames=expression_names,
                ReturnValues="UPDATED_NEW"
            )

            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "message": "Profile updated successfully",
                    "updatedAttributes": response.get('Attributes')
                }, cls=DecimalEncoder)
            }

    except Exception as e:
        print(f"Error: {str(e)}")
        return { 
            "statusCode": 500, 
            "headers": headers,
            "body": json.dumps(f"Server Error: {str(e)}") 
        }