import boto3
import json
import uuid
import datetime
import os
from decimal import Decimal

# --- CLIENTS ---
comprehend = boto3.client(service_name='comprehend', region_name='us-east-1')
transcribe = boto3.client(service_name='transcribe', region_name='us-east-1')
bedrock = boto3.client(service_name='bedrock-runtime', region_name='us-east-1')
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')

TABLE_NAME = "mediconnect-medical-records" 
table = dynamodb.Table(TABLE_NAME)

def generate_summary(text):
    print("🤖 Bedrock Generating Summary (Nova Micro)...")
    try:
        # --- NEW: Amazon Nova Micro Payload Format ---
        model_id = "us.amazon.nova-micro-v1:0"
        
        body = json.dumps({
            "messages": [
                {
                    "role": "user",
                    "content": [{"text": f"Summarize these medical symptoms briefly: {text}"}]
                }
            ],
            "inferenceConfig": {
                "max_new_tokens": 100,
                "temperature": 0.5
            }
        })

        response = bedrock.invoke_model(
            modelId=model_id,
            body=body
        )
        
        response_body = json.loads(response['body'].read())
        # Parse Nova response
        summary = response_body['output']['message']['content'][0]['text'].strip()
        return summary

    except Exception as e:
        print(f"Bedrock Error: {e}")
        # Fallback if AI fails so the rest of the app doesn't crash
        return "Summary pending (AI processing)"

def analyze_medical_text(text):
    print("🧠 AI Analyzing text (Standard Mode)...")
    try:
        response = comprehend.detect_key_phrases(Text=text, LanguageCode='en')
        entities = []
        for phrase in response['KeyPhrases']:
            entities.append({
                'Text': phrase['Text'],
                'Category': 'KEY_PHRASE', 
                'Type': 'N/A',
                'Confidence': Decimal(str(phrase['Score']))
            })
        return entities
    except Exception as e:
        print(f"Comprehend Error: {e}")
        return []

def start_transcription(file_url, job_name):
    print(f"🎙️ Starting Transcription for {file_url}...")
    try:
        transcribe.start_transcription_job(
            TranscriptionJobName=job_name,
            LanguageCode='en-US',
            Media={'MediaFileUri': file_url},
            OutputBucketName='mediconnect-consultation-recordings',
            MediaFormat='mp4' 
        )
        return "JOB_STARTED"
    except Exception as e:
        print(f"Transcription Error: {e}")
        return "ERROR"

def lambda_handler(event, context):
    try:
        body = json.loads(event.get('body', '{}')) if isinstance(event.get('body'), str) else event
        action = body.get('action', 'analyze_text')
        patient_id = body.get('patientId')
        doctor_id = body.get('doctorId')
        
        if not patient_id:
            return {"statusCode": 400, "body": "Missing patientId"}

        result_data = {}
        record_id = str(uuid.uuid4())
        timestamp = datetime.datetime.utcnow().isoformat()

        if action == 'analyze_text':
            clinical_note = body.get('text')
            if not clinical_note:
                return {"statusCode": 400, "body": "No text provided"}
            
            ai_entities = analyze_medical_text(clinical_note)
            ai_summary = generate_summary(clinical_note)
            
            item = {
                'patientId': patient_id,
                'recordId': record_id,
                'doctorId': doctor_id,
                'type': 'AI_ANALYSIS',
                'originalText': clinical_note,
                'extractedEntities': ai_entities,
                'summary': ai_summary,
                'createdAt': timestamp
            }
            
            table.put_item(Item=item)
            result_data = item

        elif action == 'transcribe_audio':
            audio_url = body.get('audioUrl')
            job_name = f"transcribe_{patient_id}_{int(datetime.datetime.now().timestamp())}"
            status = start_transcription(audio_url, job_name)
            result_data = {"status": status, "jobName": job_name}

        def decimal_default(obj):
            if isinstance(obj, Decimal): return float(obj)
            return str(obj)

        return {
            "statusCode": 200,
            "body": json.dumps(result_data, default=decimal_default)
        }

    except Exception as e:
        print(f"Error: {e}")
        return {"statusCode": 500, "body": str(e)}