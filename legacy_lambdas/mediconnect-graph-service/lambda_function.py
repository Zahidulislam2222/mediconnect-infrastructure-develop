import json
import boto3
import os
import logging
from boto3.dynamodb.conditions import Key

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize DynamoDB client
dynamodb = boto3.resource('dynamodb')

def lambda_handler(event, context):
    """
    Handles Graph Relationships (Create & Read).
    - POST: Creates a bidirectional relationship (A->B, B->A).
    - GET: Fetches all relationships for a specific Entity ID.
    """
    
    # 🔒 CORS HEADERS (Required for React Frontend)
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
    }

    # Handle Pre-flight (OPTIONS) check from Browser
    if event.get('httpMethod') == 'OPTIONS':
        return {
            "statusCode": 200,
            "headers": headers,
            "body": ""
        }
    
    # Get table name
    table_name = os.environ.get('GRAPH_TABLE_NAME')
    if not table_name:
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": "Server configuration error: GRAPH_TABLE_NAME missing."})
        }
        
    table = dynamodb.Table(table_name)

    try:
        # --- READ LOGIC (GET) ---
        if event.get('httpMethod') == 'GET':
            params = event.get('queryStringParameters') or {}
            entity_id = params.get('entityId') # e.g., "PATIENT#123"

            if not entity_id:
                return {
                    "statusCode": 400,
                    "headers": headers,
                    "body": json.dumps({"error": "Missing 'entityId' query parameter."})
                }

            # Query DynamoDB for all items where PK matches the Entity ID
            response = table.query(
                KeyConditionExpression=Key('PK').eq(entity_id)
            )
            
            items = response.get('Items', [])
            
            return {
                "statusCode": 200,
                "headers": headers,
                "body": json.dumps({
                    "entity": entity_id,
                    "connections": items
                })
            }

        # --- WRITE LOGIC (POST) ---
        if event.get('httpMethod') == 'POST':
            body = json.loads(event.get('body', '{}'))
            entity_a = body.get('entityA')
            entity_b = body.get('entityB')
            relationship = body.get('relationship')

            if not all([entity_a, entity_b, relationship]):
                raise ValueError("Request body must contain 'entityA', 'entityB', and 'relationship'.")
            
            logger.info(f"Creating relationship '{relationship}' between {entity_a} and {entity_b}")
            
            # Use BatchWriter for atomic-like write of both directions
            with table.batch_writer() as batch:
                # 1. Forward (A -> B)
                batch.put_item(Item={
                    'PK': entity_a,
                    'SK': entity_b,
                    'relationship': relationship,
                    'createdAt': '2026-01-16T00:00:00Z' # Simplified timestamp
                })
                
                # 2. Reverse (B -> A)
                batch.put_item(Item={
                    'PK': entity_b,
                    'SK': entity_a,
                    'relationship': relationship,
                    'createdAt': '2026-01-16T00:00:00Z'
                })
                
            return {
                "statusCode": 201,
                "headers": headers,
                "body": json.dumps({
                    "message": "Relationship created successfully.",
                    "link": f"{entity_a} <-> {entity_b}"
                })
            }

    except Exception as e:
        logger.error(f"Error: {e}")
        return {
            "statusCode": 500,
            "headers": headers,
            "body": json.dumps({"error": str(e)})
        }