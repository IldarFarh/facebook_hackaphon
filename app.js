/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  bd = require('./config/bd.json'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  scraper = require('open-graph-scraper'),
  request = require('request');

var app = express();
app.set('port', process.env.PORT || 5000);
app.set('view engine', 'ejs');
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * Be sure to setup your config values before running this code. You can
 * set them using environment variables or modifying the config file in /config.
 *
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = (process.env.SERVER_URL) ?
  (process.env.SERVER_URL) :
  config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});


/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // Make sure this is a page subscription
  if (data.object == 'page') {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function(pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function(messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log("Webhook received unknown messagingEvent: ", messagingEvent);
        }
      });
    });

    // Assume all went well.
    //
    // You must send back a 200, within 20 seconds, to let us know you've
    // successfully received the callback. Otherwise, the request will time out.
    res.sendStatus(200);
  }
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get('/authorize', function(req, res) {
  var accountLinkingToken = req.query.account_linking_token;
  var redirectURI = req.query.redirect_uri;

  // Authorization Code should be generated per user by the developer. This will
  // be passed to the Account Linking callback.
  var authCode = "1234567890";

  // Redirect users to this URI on successful login
  var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

  res.render('authorize', {
    accountLinkingToken: accountLinkingToken,
    redirectURI: redirectURI,
    redirectURISuccess: redirectURISuccess
  });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log("Received authentication for user %d and page %d with pass " +
    "through param '%s' at %d", senderID, recipientID, passThroughParam,
    timeOfAuth);

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("Received message for user %d and page %d at %d with message:",
    senderID, recipientID, timeOfMessage);
  console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    // Just logging message echoes to console
    console.log("Received echo for message %s and app %d with metadata %s",
      messageId, appId, metadata);
    return;
  } else if (quickReply) {
    var quickReplyPayload = quickReply.payload;
    console.log("Quick reply for message %s with payload %s",
      messageId, quickReplyPayload);

    resolveQuickReply(senderID, quickReplyPayload);
    return;
  }

  if (messageText) {

    // If we receive a text message, check to see if it matches any special
    // keywords and send back the corresponding example. Otherwise, just echo
    // the text we received.
    switch (messageText.replace(/[^\w\s]/gi, '').trim().toLowerCase()) {
      case 'hello':
      case 'hi':
      case 'start':
        bd.ingredients = [];
        sendHiMessage(senderID);
        break;

      case 'done':
        if (bd.ingredients.length > 0) getTheRecipesList(senderID)
        else sendTextMessage(senderID, "Plese provide some info");
        break;

      default:
          sendQuickReply(senderID);
          // sendTextMessage(senderID, "Please type 'start' or 'done'");
    }
  } else if (messageAttachments) {
    const link = messageAttachments[0].payload.url;
    request({
      uri: 'https://5a4f6dff.ngrok.io/images/',
      method: 'POST',
      json: {
        url: link 
      }
    }, function (error, response, body) {

      if (!error && response.statusCode == 200) {
        bd.ingredients.push(body[0])
        callSendAPI({
          recipient: {
            id: senderID
          },
          message: {
            text: "We get your " + body[0] + ".\n What do you want to do next?",
            quick_replies: [
              {
                "content_type":"text",
                "title":"Choose more",
                "payload":"START"
              },
              {
                "content_type":"text",
                "title":"Get recipe",
                "payload":"DONE"
              }
            ]
          }
        });
        
      } else {
        sendTextMessage(recipientId, "Some error has occured");
        console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
      }
    });
  }
}


/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Received delivery confirmation for message ID: %s",
        messageID);
    });
  }

  console.log("All message before %d were delivered.", watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  if (payload.includes('LIKED')) {
    const used_ingerdients = payload.substring(6).split(',');
    bd.ingredients = bd.ingredients.filter(value => !used_ingerdients.includes(value));
  } else if (payload.includes('BIN'))  {
    bd.excluded_recipes.push(payload.substring(4));
    getTheRecipesList(senderID, 'UPDATE');
    return;
  }


  console.log("Received postback for user %d and page %d with payload '%s' " +
    "at %d", senderID, recipientID, payload, timeOfPostback);

  callSendAPI({
    recipient: {
      id: senderID
    },
    message: {
      text: "Left: " + bd.ingredients.join(", "),
      quick_replies: [
        {
          "content_type":"text",
          "title":"Choose more",
          "payload":"START"
        },
        {
          "content_type":"text",
          "title":"Get recipe",
          "payload":"DONE"
        },
        {
          "content_type":"text",
          "title":"Leave",
          "payload":"EXIT"
        }
      ]
    }
  });
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log("Received message read event for watermark %d and sequence " +
    "number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log("Received account link event with for user %d with status %s " +
    "and auth code %s ", senderID, status, authCode);
}

function sendHiMessage(recipientId) {
  const quick_replies = Object.keys(bd.library).map(el => {
    return {
      "content_type": "text",
      "title": el,
      "payload": "PARENT_" + el
    }
  })
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "Greetings friend! Would you please provide some information about your stock? Or you can provide the photos and type done then you are done",
      quick_replies
    }
  }

  callSendAPI(messageData);
}

function resolveQuickReply(recipientId, payload) {
  let messageData = {
    recipient: {
      id: recipientId
    },
    message: {}
  }

  if (payload.includes('PARENT')) {
    messageData.message.text = `Choose ${payload.substring(7)} you got`
    messageData.message.quick_replies = bd.library[payload.substring(7)].map(el => {
      return {
        "content_type":"text",
        "title":el,
        "payload": "INGREDIENT_" + el
      }
    })
  } else if (payload.includes('INGREDIENT'))  {
    bd.ingredients.push(payload.substring(11).toLowerCase())
    messageData.message.text = "Do you have more ingredients?"
    messageData.message.quick_replies = [{
      "content_type":"text",
      "title":"Yes",
      "payload": 'CHOOSE_YES'
    },
    {
      "content_type":"text",
      "title":"No",
      "payload": 'DONE'
    }]
  } else {
    if (payload === 'START') {
      sendHiMessage(recipientId)
      return;
    } else if (payload === 'CHOOSE_YES') {
      messageData.message.text = "Choose your next ingredient:"
      messageData.message.quick_replies = Object.keys(bd.library).map(el => {
        return {
          "content_type":"text",
          "title":el,
          "payload": "PARENT_" + el
        } 
      })
    } else if (payload === 'DONE') {
      getTheRecipesList(recipientId)
      return;
    }    
  }

  callSendAPI(messageData);
}

function getTheRecipesList(recipientId, state = 'NEW') {
  if (bd.ingredients.length === 0) {
    sendTextMessage(recipientId, "Plese provide some info");
    return;
  }

  sendTypingOn(recipientId);
  request({
    uri: 'https://5a4f6dff.ngrok.io/recipes/',
    method: 'POST',
    json: {
      sender_id: recipientId,
      ingredients: bd.ingredients ,
      excluded_ingredients: [],
      recipes: [],
      excluded_recipes: bd.excluded_recipes,
      state
    }
  }, function (error, response, body) {

    if (!error && response.statusCode == 200) {
      recipesToUser(recipientId, body)
    } else {
      sendTypingOff(recipientId);
      sendTextMessage(recipientId, "Some error has occured");
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

function recipesToUser(recipientId, response) {

  Promise.all(response.recipes.map(el => {
    return getImageFromUrl(el.url).then(imageUrl => {  
      const need = el.ingredients.join(", ");
      const have = bd.ingredients.join(", ");
      const get = el.ingredients.filter(value => !bd.ingredients.includes(value)).join(", ") ? el.ingredients.filter(value => !bd.ingredients.includes(value)).join(", ") : "Nothing";         
      return {
        title: el.title,
        subtitle: `You need: ${need}\n Need to get: ${get}`,
        item_url: el.url,
        image_url: imageUrl,
        buttons: [{
          type: "postback",
          payload: "LIKED_" + el.ingredients.join(","),
          title: "👌"
        }, {
          type: "postback",
          title: "🗑️",
          payload: "BIN_" + el.id,
        }]
      }
    })
 
  })).then(elements => {
    sendTypingOff(recipientId);

    callSendAPI( {
      recipient: {
        id: recipientId
      },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements
          }
        }
      }
    })

  })
    
}

function getImageFromUrl(URL) {
return new Promise(resolve => {
  var options = {'url': URL};
  let defaultImage =  'https://www.netclipart.com/pp/m/180-1800966_man-cooking-png-cartoon-man-cooking-png.png';
  scraper(options, function (error, results) {
  
    if (!error &&  results.data.ogImage.url!==undefined) {
      resolve( results.data.ogImage.url)
    }else {
      resolve(defaultImage)
    }
  });
})


}

function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText,
      metadata: "DEVELOPER_DEFINED_METADATA"
    }
  };

  callSendAPI(messageData);
}

function sendQuickReply(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: "What do you want to do?",
      quick_replies: [
        {
          "content_type":"text",
          "title":"Start the app",
          "payload":"START"
        },
        {
          "content_type":"text",
          "title":"Get recipe",
          "payload":"DONE"
        }
      ]
    }
  };

  callSendAPI(messageData);
}

function sendTypingOn(recipientId) {
  console.log("Turning typing indicator on");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  console.log("Turning typing indicator off");

  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_off"
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      if (messageId) {
        console.log("Successfully sent message with id %s to recipient %s",
          messageId, recipientId);
      } else {
      console.log("Successfully called Send API for recipient %s",
        recipientId);
      }
    } else {
      console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
    }
  });
}

// Start server
// Webhooks must be available via SSL with a certificate signed by a valid
// certificate authority.
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
