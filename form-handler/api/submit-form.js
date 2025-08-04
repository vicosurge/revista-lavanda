// /api/submit-form.js
import formidable from 'formidable';
import fs from 'fs';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Disable default body parser for file uploads
export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse the multipart form data
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024, // 10MB limit
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    
    // Extract form data (assuming single values, adjust if multiple values possible)
    const formData = {};
    Object.keys(fields).forEach(key => {
      formData[key] = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
    });

    // Get the uploaded file
    const uploadedFile = files.archivo ? (Array.isArray(files.archivo) ? files.archivo[0] : files.archivo) : null;
    
    if (!uploadedFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Upload file to Dropbox and store data in Airtable
    const dropboxResponse = await uploadToDropbox(uploadedFile);
    
    const airtableResponse = await storeInAirtable({
      ...formData,
      fileName: uploadedFile.originalFilename,
      dropboxUrl: dropboxResponse.url,
    }, uploadedFile);

    // Send Slack notification
    await sendSlackNotification({
      ...formData,
      fileName: uploadedFile.originalFilename,
      dropboxUrl: dropboxResponse.url,
      airtableRecordId: airtableResponse.id,
      airtableUrl: `https://airtable.com/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}/${airtableResponse.id}`,
    });

    // Clean up temporary file
    fs.unlinkSync(uploadedFile.filepath);

    res.status(200).json({ 
      success: true, 
      message: 'Submission processed successfully',
      recordId: airtableResponse.id 
    });

  } catch (error) {
    console.error('Error processing form submission:', error);
    
    // Send error notification to Slack
    await sendErrorToSlack(error);
    
    res.status(500).json({ 
      error: 'Internal server error', 
      message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong' 
    });
  }
}

async function uploadToDropbox(file) {
  const fileBuffer = fs.readFileSync(file.filepath);
  
  console.log('Uploading to Dropbox:', {
    filename: file.originalFilename,
    fileSize: fileBuffer.length,
    hasToken: !!process.env.DROPBOX_ACCESS_TOKEN
  });
  
  const dropboxArgs = {
    path: `/submissions/${file.originalFilename}`,
    mode: 'add',
    autorename: true,
  };
  
  console.log('Dropbox API Args:', dropboxArgs);
  
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify(dropboxArgs),
    },
    body: fileBuffer,
  });

  console.log('Dropbox upload response status:', response.status);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('Dropbox error response:', errorText);
    throw new Error(`Dropbox upload failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('Dropbox upload success:', result);
  
  // Create a shared link for the file
  const linkResponse = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      path: result.path_display,
      settings: {
        requested_visibility: 'team_only',
      },
    }),
  });

  if (!linkResponse.ok) {
    const linkErrorText = await linkResponse.text();
    console.error('Dropbox link creation error:', linkErrorText);
    
    // Try the simpler create_shared_link endpoint instead
    const simpleLinkResponse = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.DROPBOX_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        path: result.path_display,
      }),
    });
    
    if (simpleLinkResponse.ok) {
      const simpleLinkResult = await simpleLinkResponse.json();
      return {
        path: result.path_display,
        url: simpleLinkResult.url,
      };
    }
    
    // If both fail, return a path that works
    return {
      path: result.path_display,
      url: `https://www.dropbox.com/home/submissions`,
    };
  }

  const linkResult = await linkResponse.json();
  console.log('Dropbox link result:', linkResult);
  
  return {
    path: result.path_display,
    url: linkResult.url,
  };
}

async function storeInAirtable(data, file) {
  const response = await fetch(`https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_NAME}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AIRTABLE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        // Match your actual form field names
        'Nombre': data.nombre || '',
        'Email': data.email || '',
        'Tipo de Trabajo': data.tipo || '',
        'Título': data.titulo || '',
        'Biografía': data.bio || '',
        'Notas': data.notas || '',
        'File Name': data.fileName,
        'Dropbox URL': data.dropboxUrl,
      },
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Airtable storage failed: ${JSON.stringify(errorData)}`);
  }

  return await response.json();
}

async function sendSlackNotification(data) {
  const message = {
    text: "📝 New Form Submission Received!",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "📝 New Submission"
        }
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Nombre:*\n${data.nombre || 'No proporcionado'}`
          },
          {
            type: "mrkdwn",
            text: `*Email:*\n${data.email || 'No proporcionado'}`
          },
          {
            type: "mrkdwn",
            text: `*Tipo:*\n${data.tipo || 'No especificado'}`
          },
          {
            type: "mrkdwn",
            text: `*Título:*\n${data.titulo || 'Sin título'}`
          }
        ]
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Biografía:*\n${data.bio || 'No proporcionada'}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Notas:*\n${data.notas || 'Sin notas adicionales'}`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📁 <${data.dropboxUrl}|View File in Dropbox>`
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📋 <${data.airtableUrl}|View Submission in Airtable>`
        }
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Submission ID: ${data.airtableRecordId} | ${new Date().toLocaleString()}`
          }
        ]
      }
    ]
  };

  const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    throw new Error(`Slack notification failed: ${response.statusText}`);
  }
}

async function sendErrorToSlack(error) {
  try {
    const errorMessage = {
      text: "🚨 Form Submission Error",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🚨 Form Processing Error"
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Error:* ${error.message}\n*Time:* ${new Date().toLocaleString()}`
          }
        }
      ]
    };

    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(errorMessage),
    });
  } catch (slackError) {
    console.error('Failed to send error notification to Slack:', slackError);
  }
}
