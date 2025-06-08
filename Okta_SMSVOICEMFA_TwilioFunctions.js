const { SignalWire, Voice } = require('@signalwire/realtime-api');
const axios = require('axios');

exports.handler = async function (context, event, callback) {
  try {
    // Normalize headers to lowercase keys
    const headers = Object.fromEntries(
      Object.entries(event.request.headers).map(([k, v]) => [k.toLowerCase(), v])
    );

    // Authentication check
    if (context.AUTH_SECRET !== headers['auth_secret']) {
      throw new Error("Authentication failed");
    }

    // Initialize SignalWire Realtime API Client with env vars
    const client = await SignalWire({
      project: context.SIGNALWIRE_PROJECT_ID,
      token: context.SIGNALWIRE_API_TOKEN,
    });

    // Extract phone number and OTP from the event data
    const to = event.data.messageProfile.phoneNumber;
    const customCode = event.data.messageProfile.otpCode;

    if (!to || !customCode) throw new Error("Missing phone number or OTP");

    // Use deliveryChannel (sms or call) per Okta's spec
    const channel = event.data.messageProfile.deliveryChannel.toLowerCase();

    if (channel === 'sms') {
      const lookupUrl = `https://${context.SIGNALWIRE_SPACE}/api/relay/rest/lookup/phone_number/${encodeURIComponent(to)}?include=carrier`;

let numberInfo;
try {
  const lookupResponse = await axios.get(lookupUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${context.SIGNALWIRE_PROJECT_ID}:${context.SIGNALWIRE_API_TOKEN}`).toString('base64'),
      'Content-Type': 'application/json'
    }
  });
  numberInfo = lookupResponse.data;
} catch (err) {
  throw new Error(`Lookup failed: ${err.message}`);
}
const lineType = numberInfo?.carrier?.linetype?.toLowerCase();

if (!['wireless', 'voip'].includes(lineType)) {
  throw new Error(`Cannot send SMS to non-mobile number. Detected line type: ${lineType}`);
}
      
      // Sending SMS with OTP
      const sendResult = await client.messaging.send({
        from: context.SIGNALWIRE_FROM_NUMBER,
        to,
        body: `Your verification code is: ${customCode}`,
      });

      // Success response for SMS
      const response = {
        commands: [
          {
            type: "com.okta.telephony.action",
            value: [
              {
                status: "SUCCESSFUL",
                provider: "SignalWire",
                transactionId: sendResult.id,
              },
            ],
          },
        ],
      };

      return callback(null, response);

    } else if (channel === 'call') {
      // Initialize the Voice Client to make a call
      const voiceClient = client.voice;

      // Dial the phone number
      const call = await voiceClient.dialPhone({
        from: context.SIGNALWIRE_FROM_NUMBER,
        to,
      });

      // Play the OTP as TTS (Text-to-Speech) asynchronously
      const spacedCode = customCode.split('').join(' ');
      call.playTTS({
        text:
          `<speak>
      Hello! Your verification code is 
      <prosody rate="x-slow">
        ${spacedCode}
      </prosody> <break time="1s"/>
      Again, your verification code is 
      <prosody rate="x-slow">
        ${spacedCode}
      </prosody>
    </speak>`,
        voice: "polly.Ruth",
        listen: {
          onStarted: () => console.log("Playback started"),
          onUpdated: (playback) => console.log("Playback updated", playback.state),
          onEnded: async (playback) => {
            console.log("Playback ended", playback.state);
            await call.hangup();
          },
          onFailed: () => console.log("Playback failed")
        }
      });

      // Immediately return success response
      const response = {
        commands: [
          {
            type: "com.okta.telephony.action",
            value: [
              {
                status: "SUCCESSFUL",
                provider: "SignalWire",
                transactionId: call.sid,
              },
            ],
          },
        ],
      };
      return callback(null, response);
    

    } else {
      throw new Error("Unsupported delivery channel. Must be 'sms' or 'call'.");
    }

  } catch (error) {
    console.error("Error occurred:", error);

    // Error response
    const errorResponse = {
      error: {
        errorSummary: error.message,
        errorCauses: [
          {
            errorSummary: error.message,
            reason: error.message,
          },
        ],
      },
    };

    return callback(null, errorResponse);
  }
};
