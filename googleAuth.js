const { google } = require('googleapis');

// Ortam değişkeninden gelen JSON string'i düzgün parse ediliyor
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'));

const auth = new google.auth.JWT(
  serviceAccount.client_email,
  null,
  serviceAccount.private_key,
  ['https://www.googleapis.com/auth/admin.directory.group.readonly'],
  process.env.GOOGLE_IMPERSONATE_ADMIN_EMAIL
);

const directory = google.admin({ version: 'directory_v1', auth });

async function isUserInGroup(userEmail) {
  try {
    const res = await directory.members.hasMember({
      groupKey: process.env.GOOGLE_ALLOWED_GROUP_EMAIL,
      memberKey: userEmail,
    });
    return res.data.isMember;
  } catch (err) {
    console.error('Membership check failed:', err.message);
    return false;
  }
}

module.exports = { isUserInGroup };
