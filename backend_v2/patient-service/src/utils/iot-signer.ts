import * as crypto from 'crypto';

function sha256(message: string): string {
    return crypto.createHash('sha256').update(message).digest('hex');
}

function hmac(key: string | Buffer, message: string): Buffer {
    return crypto.createHmac('sha256', key).update(message).digest();
}

export function getSignedIoTUrl(
    endpoint: string, // e.g. "mqtts://xyz.iot.us-east-1.amazonaws.com"
    region: string,
    accessKey: string,
    secretKey: string,
    sessionToken?: string
): string {
    const time = new Date();
    const dateStamp = time.toISOString().split('T')[0].replace(/-/g, '');
    const amzDate = time.toISOString().replace(/[:\-]|\.\d{3}/g, '');
    const service = 'iotdevicegateway';
    const algorithm = 'AWS4-HMAC-SHA256';
    const method = 'GET';
    const canonicalUri = '/mqtt';
    
    // Clean endpoint: remove protocol and ensure it's just the host
    const host = endpoint.replace('mqtts://', '').replace('wss://', '').replace('/', '');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    let canonicalQuerystring = `X-Amz-Algorithm=${algorithm}`;
    canonicalQuerystring += `&X-Amz-Credential=${encodeURIComponent(accessKey + '/' + credentialScope)}`;
    canonicalQuerystring += `&X-Amz-Date=${amzDate}`;
    canonicalQuerystring += `&X-Amz-Expires=86400`;
    canonicalQuerystring += `&X-Amz-SignedHeaders=host`;
    
    if (sessionToken) {
        canonicalQuerystring += `&X-Amz-Security-Token=${encodeURIComponent(sessionToken)}`;
    }

    const canonicalHeaders = `host:${host}\n`;
    const payloadHash = sha256('');
    const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuerystring}\n${canonicalHeaders}\nhost\n${payloadHash}`;

    const kDate = hmac(`AWS4${secretKey}`, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    const kSigning = hmac(kService, 'aws4_request');

    const stringToSign = `${algorithm}\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;
    const signature = hmac(kSigning, stringToSign).toString('hex');

    return `wss://${host}/mqtt?${canonicalQuerystring}&X-Amz-Signature=${signature}`;
}