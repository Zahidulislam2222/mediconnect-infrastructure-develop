import json
import boto3
import base64
import os

# Initialize Clients
s3 = boto3.client('s3')
rekognition = boto3.client('rekognition')
dynamodb = boto3.resource('dynamodb')

# Ensure this bucket name is correct
BUCKET_NAME = "mediconnect-identity-verification"

def lambda_handler(event, context):
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    }

    # 1. CORS Preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {"statusCode": 200, "headers": headers, "body": ""}

    try:
        # 2. Parse Body
        body = json.loads(event['body']) if isinstance(event.get('body'), str) else event.get('body', {})

        user_id = body.get('userId')
        if not user_id:
            return {"statusCode": 400, "headers": headers, "body": json.dumps("Missing userId")}

        # Normalize Role
        raw_role = body.get('role', 'patient')
        user_role = 'doctor' if raw_role == 'provider' else raw_role
        
        # Select DynamoDB Table
        table_name = "mediconnect-doctors" if user_role == 'doctor' else "mediconnect-patients"
        id_key_field = 'doctorId' if user_role == 'doctor' else 'patientId'

        # 3. Decode Images
        if 'selfieImage' not in body:
             return {"statusCode": 400, "headers": headers, "body": json.dumps("No selfieImage provided")}
        
        try:
            selfie_bytes = base64.b64decode(body['selfieImage'])
        except:
             return {"statusCode": 400, "headers": headers, "body": json.dumps("Invalid Selfie Base64")}

        # 🟢 CRITICAL STEP: Upload the Source ID Card to S3 FIRST
        id_card_key = f"{user_role}/{user_id}/id_card.jpg"
        
        # We need an ID image to compare against. 
        # If frontend sent it, save it.
        if 'idImage' in body and body['idImage']:
            try:
                id_bytes = base64.b64decode(body['idImage'])
                
                # 1. Upload the file
                s3.put_object(
                    Bucket=BUCKET_NAME, 
                    Key=id_card_key, 
                    Body=id_bytes, 
                    ContentType='image/jpeg'
                )

                # ---------------------------------------------------------
                # NEW CODE: Add Tag for Auto-Deletion (Lifecycle Rule)
                # ---------------------------------------------------------
                s3.put_object_tagging(
                    Bucket=BUCKET_NAME,
                    Key=id_card_key,
                    Tagging={
                        'TagSet': [
                            {'Key': 'auto-delete', 'Value': 'true'}
                        ]
                    }
                )
                # ---------------------------------------------------------

                print(f"✅ ID Card uploaded and tagged: {id_card_key}")
            except Exception as e:
                print(f"⚠️ S3 Upload/Tag Error: {str(e)}")
                return {"statusCode": 500, "headers": headers, "body": json.dumps("Failed to save ID card to S3.")}
        
        # 4. Run Rekognition (Compare Selfie vs ID Card in S3)
        verification_result = False
        confidence = 0
        message = "Identity Verification Failed"

        try:
            response = rekognition.compare_faces(
                SourceImage={'S3Object': {'Bucket': BUCKET_NAME, 'Name': id_card_key}},
                TargetImage={'Bytes': selfie_bytes},
                SimilarityThreshold=80
            )
            
            if len(response['FaceMatches']) > 0:
                match = response['FaceMatches'][0]
                confidence = match['Similarity']
                verification_result = True
                message = f"Identity Verified. Confidence: {confidence:.2f}%"
                print(f"✅ Identity Verification: SUCCESS. Match Confidence: {confidence:.2f}%")
            else:
                message = "Face does not match the provided ID card."

        except rekognition.exceptions.InvalidS3ObjectException:
            # This is the 404 error you saw before. 
            # It means the ID card wasn't uploaded in the previous step.
            return {"statusCode": 404, "headers": headers, "body": json.dumps("ID Document missing. Please ensure ID is uploaded.")}
        except Exception as e:
            print(f"Rekognition Error: {str(e)}")
            message = "Face comparison failed. Ensure images are clear."

       # 5. Update Database if Verified
        db_status = "Skipped"
        secure_url_for_frontend = None

        if verification_result:
            # Define the Path
            selfie_key = f"{user_role}/{user_id}/selfie_verified.jpg"
            
            # Upload to S3
            s3.put_object(Bucket=BUCKET_NAME, Key=selfie_key, Body=selfie_bytes, ContentType='image/jpeg')

            # Generate temporary link JUST for the immediate response
            secure_url_for_frontend = s3.generate_presigned_url(
                'get_object',
                Params={'Bucket': BUCKET_NAME, 'Key': selfie_key},
                ExpiresIn=3600
            )
            
            try:
                table = dynamodb.Table(table_name)
                
                # Update attributes. 
                # CRITICAL CHANGE: We save 'selfie_key' (the path), NOT the URL.
                update_expr = "set avatar = :a, isIdentityVerified = :v, verificationStatus = :s"
                expr_values = {
                    ':a': selfie_key,
                    ':v': True,
                    ':s': "PENDING_REVIEW" if user_role == 'doctor' else "VERIFIED"
                }

                table.update_item(
                    Key={id_key_field: user_id},
                    UpdateExpression=update_expr,
                    ExpressionAttributeValues=expr_values
                )
                db_status = "Profile Updated"
            except Exception as e:
                db_status = f"DB Error: {str(e)}"
                print(db_status)

        return {
            "statusCode": 200,
            "headers": headers,
            "body": json.dumps({
                "verified": verification_result,
                "confidence": confidence,
                "message": message,
                "photoUrl": secure_url_for_frontend if verification_result else None
            })
        }

    except Exception as e:
        print(f"Global Error: {str(e)}")
        return {"statusCode": 500, "headers": headers, "body": json.dumps(f"Server Error: {str(e)}")}