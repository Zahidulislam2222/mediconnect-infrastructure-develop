const { CognitoJwtVerifier } = require("aws-jwt-verify");

// Initialize Verifier outside the handler for warm-start performance
const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",
  clientId: process.env.COGNITO_CLIENT_ID,
});

exports.handler = async (event) => {
  const token = event.queryStringParameters?.token;

  // 🟢 SECURITY: Handle missing token or literal "null" string from frontend
  if (!token || token === "null" || token.split('.').length !== 3) {
    console.error("[WS-Auth] Invalid Token Format detected");
    return generatePolicy('user', 'Deny', event.methodArn);
  }

  try {
    // 🟢 AUTH: Strict signature and expiry verification
    const payload = await verifier.verify(token);

    // 🟢 HIPAA: Identify the actor by their unique Cognito 'sub'
    const apiArnPrefix = event.methodArn.split('/').slice(0, 2).join('/') + '/*';

return generatePolicy(payload.sub, 'Allow', apiArnPrefix, payload);

  } catch (err) {
    console.error("[WS-Auth] JWT Verification Failed:", err.message);
    // Fail-closed for any verification error
    return generatePolicy('user', 'Deny', event.methodArn);
  }
};

/**
 * Generates a valid AWS IAM Policy for the WebSocket connection.
 */
const generatePolicy = (principalId, effect, resource, payload = null) => {
  const authResponse = {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: effect,
        Resource: resource,
      }],
    },
  };

  // 🟢 FIX: Only attach context metadata if the user is ALLOWED
  // API Gateway will crash if values are undefined/null
  if (effect === 'Allow' && payload) {
    
    // Determine user role (Doctor vs Patient)
    let userRole = 'patient';
    if (payload['cognito:groups'] && payload['cognito:groups'].includes('doctor')) {
        userRole = 'doctor';
    } else if (payload['custom:role']) {
        userRole = String(payload['custom:role']);
    }

    authResponse.context = {
      sub: String(payload.sub),
      role: String(userRole),
      // GDPR: Minimal data shared. Only use email if backend requires it for logic.
      email: payload.email ? String(payload.email) : ""
    };
  }

  return authResponse;
};