import json
import boto3
import os
import logging
from botocore.exceptions import ClientError
import uuid

# Initialize the S3 client
s3_client = boto3.client('s3')

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

def lambda_handler(event, context):
    """
    This function generates a presigned URL for uploading a file to the secure
    consultation S3 bucket. It expects a JSON body with a 'fileName' key.
    Example body: { "fileName": "patient-xray.jpg" }
    """
    
    # Get the S3 bucket name from an environment variable for security.
    bucket_name = os.environ.get('UPLOAD_BUCKET')
    if not bucket_name:
        logger.error("FATAL: UPLOAD_BUCKET environment variable is not set.")
        return {
            "statusCode": 500,
            "headers": { "Access-Control-Allow-Origin": "*" },
            "body": json.dumps({"error": "Server configuration error."})
        }

    # Get the original file name from the API Gateway event body
    try:
        body = json.loads(event.get('body', '{}'))
        original_file_name = body.get('fileName')
        if not original_file_name:
            raise ValueError("fileName not found in request body.")
    except (json.JSONDecodeError, ValueError) as e:
        logger.error(f"Invalid request body: {e}")
        return {
            "statusCode": 400,
            "headers": { "Access-Control-Allow-Origin": "*" },
            "body": json.dumps({"error": "Invalid request. 'fileName' is required."})
        }

    # Generate a unique ID to prevent file name conflicts.
    # This creates a unique object key like: "uploads/a1b2c3d4/patient-xray.jpg"
    unique_id = str(uuid.uuid4())
    object_key = f"uploads/{unique_id}/{original_file_name}"

    # Set the expiration time for the URL (300 seconds = 5 minutes)
    expiration = 300

    try:
        # Generate the presigned URL for a PUT request
        presigned_url = s3_client.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': bucket_name,
                'Key': object_key
            },
            ExpiresIn=expiration
        )
        
        logger.info(f"Successfully generated presigned URL for {object_key}")
        
        # Return the successful response
        return {
            "statusCode": 200,
            "headers": { "Access-Control-Allow-Origin": "*" },
            "body": json.dumps({
                "uploadURL": presigned_url,
                "fileKey": object_key
            })
        }
        
    except ClientError as e:
        logger.error(f"Error generating presigned URL: {e}")
        return {
            "statusCode": 500,
            "headers": { "Access-Control-Allow-Origin": "*" },
            "body": json.dumps({"error": "Could not generate file upload URL."})
        }