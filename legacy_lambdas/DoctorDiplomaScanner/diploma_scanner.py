import boto3
import re

# Initialize Textract Client (Auto-detects region)
textract = boto3.client('textract')

def scan_diploma(bucket_name, file_key):
    """
    1. Sends image from S3 to Textract.
    2. Extracts text.
    3. Performs basic validation logic.
    """
    print(f"Scanning document: {file_key} from bucket: {bucket_name}")

    try:
        response = textract.detect_document_text(
            Document={
                'S3Object': {
                    'Bucket': bucket_name,
                    'Name': file_key
                }
            }
        )
    except Exception as e:
        print(f"Textract Error: {e}")
        return {"status": "error", "message": str(e), "verification_passed": False}

    # Extract all lines of text
    detected_text = []
    if 'Blocks' in response:
        for item in response['Blocks']:
            if item['BlockType'] == 'LINE':
                detected_text.append(item['Text'])

    full_text = " ".join(detected_text)
    print(f"Extracted Text: {full_text[:100]}...") # Log first 100 chars
    
    # --- AUTOMATED VERIFICATION LOGIC ---
    # Keywords we expect to see on a valid medical license/diploma
    required_keywords = ["Doctor", "Medicine", "License", "Board", "MD", "Surgeon", "Medical", "Surgery", "Degree", "Diploma"]
    
    # Check how many keywords match (Case insensitive)
    match_count = 0
    matches_found = []
    
    for keyword in required_keywords:
        # \b ensures we match whole words only
        if re.search(r'\b' + re.escape(keyword) + r'\b', full_text, re.IGNORECASE):
            match_count += 1
            matches_found.append(keyword)

    # Decision Logic: Needs at least 1 keyword to pass
    is_valid = match_count >= 1 
    
    return {
        "status": "success",
        "verification_passed": is_valid,
        "confidence_matches": matches_found,
        "extracted_text_snippet": full_text[:200]
    }