import json
import boto3
from diploma_scanner import scan_diploma
from gcp_bigquery import record_doctor_event 

# Connect to AWS Services
dynamodb = boto3.resource('dynamodb')
sns = boto3.client('sns')

TABLE_NAME = "mediconnect-doctors"
# 🟢 IMPORTANT: Ensure this Topic exists in your SNS Console
SNS_TOPIC_ARN = "arn:aws:sns:us-east-1:950110266426:mediconnect-ops-alerts" 

def lambda_handler(event, context):
    try:
        # Get the S3 bucket and key
        record = event['Records'][0]
        s3_bucket = record['s3']['bucket']['name']
        s3_key = record['s3']['object']['key']
    except Exception as e:
        return {"statusCode": 400, "body": "Invalid Event"}

    print(f"Processing Credential for: {s3_key}")

    # 1. Run the Scan (AI Check)
    scan_result = scan_diploma(s3_bucket, s3_key)
    
    # 2. Extract Doctor ID
    parts = s3_key.split('/')
    if len(parts) > 2 and parts[1] == 'doctors':
        doctor_id = parts[2]
    elif len(parts) > 1:
        doctor_id = parts[1]
    else:
        doctor_id = "unknown_doc"
    
    # Check if scan passed
    scan_passed = scan_result['verification_passed']
    scan_status = "passed" if scan_passed else "failed"

    # 3. Log to BigQuery
    try:
        record_doctor_event(doctor_id, "diploma_verification", scan_status)
    except:
        print("BigQuery Log Skipped")

    # 4. Update DynamoDB (TIERED UPDATE)
    db_message = "Attempted DB Update"
    try:
        table = dynamodb.Table(TABLE_NAME)
        
        if scan_passed:
            # If AI passes, we move to "PENDING_REVIEW" and alert the Human Officer.
            # We DO NOT set isOfficerApproved to True yet.
            table.update_item(
                Key={'doctorId': doctor_id},
                UpdateExpression="set isDiplomaAutoVerified = :v, diplomaUrl = :u, verificationStatus = :s",
                ExpressionAttributeValues={
                    ':v': True,
                    ':u': f"s3://{s3_bucket}/{s3_key}",
                    ':s': "PENDING_REVIEW"
                }
            )
            
            # 5. SEND ALERT TO ADMIN (YOU)
            message = f"ACTION REQUIRED: Doctor {doctor_id} has uploaded a diploma. AI Check Passed. Please review and manually approve."
            sns.publish(
                TopicArn=SNS_TOPIC_ARN,
                Message=message,
                Subject="New Doctor Credential Review"
            )
            db_message = "DynamoDB Updated & Admin Alerted"
            
        else:
            # If AI fails (e.g., uploaded a cat picture)
            table.update_item(
                Key={'doctorId': doctor_id},
                UpdateExpression="set isDiplomaAutoVerified = :v, diplomaUrl = :u, verificationStatus = :s",
                ExpressionAttributeValues={
                    ':v': False,
                    ':u': f"s3://{s3_bucket}/{s3_key}",
                    ':s': "REJECTED_AUTO"
                }
            )
            db_message = "DynamoDB Updated (Auto-Rejected)"

    except Exception as e:
        print(f"DB Error: {e}")
        db_message = f"DynamoDB Update Failed: {str(e)}"

    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Processed",
            "doctor_id": doctor_id,
            "scan_passed": scan_passed,
            "db_status": db_message
        })
    }