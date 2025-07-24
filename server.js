require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = 3000;
const { google } = require('googleapis');

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));


const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.PROJECT_KEY;

console.log('Loaded environment variables:', {
  JIRA_DOMAIN,
  JIRA_EMAIL,
  JIRA_API_TOKEN: JIRA_API_TOKEN?.substring(0, 6) + '***',
  PROJECT_KEY
});

const authHeader = {
  headers: {
    Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
    Accept: 'application/json'
  }
};

// ✅ Google Sheets Auth – Jira'dan bağımsız yapı


const serviceAccountBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
const serviceAccount = JSON.parse(Buffer.from(serviceAccountBase64, 'base64').toString('utf8'));

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// authClient yerine doğrudan auth nesnesini kullan
const sheets = google.sheets({ version: 'v4', auth });



async function getAllIssues(jql) {
  const maxResults = 100;
  let startAt = 0;
  let allIssues = [];

  console.log('Executing JQL:', jql);

  while (true) {
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}`;
    console.log('Fetching URL:', url);

    try {
      const response = await axios.get(url, authHeader);
      const { issues, total } = response.data;
      allIssues = allIssues.concat(issues);
      console.log(`Fetched ${issues.length} issues (Total so far: ${allIssues.length}/${total})`);
      if (allIssues.length >= total) break;
      startAt += maxResults;
    } catch (error) {
      console.error('Jira API error:', error?.response?.data || error.message);
      throw error;
    }
  }

  return allIssues;
}

// === API Routes ===

// 1. General Issue List
app.get('/api/issues', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} ORDER BY created DESC`;
    const issues = await getAllIssues(jql);
    res.json({ issues });
  } catch (error) {
    res.status(500).json({ error: 'Jira issues could not be fetched' });
  }
});

// 2. Audit Finding Summary with Action Count
app.get('/api/finding-summary', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const findings = issues.filter(issue => issue.fields.issuetype.name === 'Audit Finding');
    const actions = issues.filter(issue => issue.fields.issuetype.name === 'Finding Action');

    const summary = findings.map(finding => {
      const findingKey = finding.key;
      const actionCount = actions.filter(a => a.fields.parent?.key === findingKey).length;

      return {
        key: findingKey,
        summary: finding.fields.summary,
        actionCount
      };
    });

    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch finding summary' });
  }
});

// 3. Findings by Year and Status (Bar Chart)
// === Yeni: Audit Type filtresi ile bar chart verisi ===
// === Güncellenmiş API: Findings by Year and Status (Bar Chart) ===
app.get('/api/finding-status-by-year', async (req, res) => {
  const { auditTypes, auditCountries } = req.query;

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const selectedTypes = Array.isArray(auditTypes)
  ? auditTypes
  : auditTypes ? [auditTypes] : null;
    const selectedCountries = auditCountries ? auditCountries.split(',') : null;

    const statusByYear = {};
    issues.forEach(issue => {
      const typeField = issue.fields.customfield_19767;
      const auditType = typeof typeField === 'object' && typeField?.value ? typeField.value : 'Unassigned';
      const countryField = issue.fields.customfield_19769;
      const auditCountry = typeof countryField === 'object' && countryField?.value ? countryField.value : 'Unassigned';

      if (selectedTypes && !selectedTypes.includes(auditType)) return;
      if (selectedCountries && !selectedCountries.includes(auditCountry)) return;

      const yearValue = issue.fields.customfield_16447;
      const year = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
      const status = issue.fields.status.name;

      if (!statusByYear[year]) statusByYear[year] = {};
      statusByYear[year][status] = (statusByYear[year][status] || 0) + 1;
    });

    res.json(statusByYear);
  } catch (error) {
    res.status(500).json({ error: 'Failed to calculate findings by year' });
  }
});

// 4. Finding Details by Year and/or Status
app.get('/api/finding-details', async (req, res) => {
  const { year, status } = req.query;
  if (!status) return res.status(400).json({ error: 'Missing status parameter' });

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

const result = issues
  .filter(issue => {
    const yearValue = issue.fields.customfield_16447;
    const issueYear = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
    const normalizedYear = (issueYear === 'Unknown' ? 'Unknown' : issueYear)?.toString();
    const issueStatus = issue.fields.status.name;

    const match = (year?.toString() === 'all' && issueStatus === status) || (normalizedYear === year?.toString() && issueStatus === status);
    
    console.log({
      yearQuery: year,
      issueYearRaw: issueYear,
      normalizedYear,
      issueStatus,
      match
    });

    return match;
  })
  .map(issue => ({
    key: issue.key,
    summary: issue.fields.summary
  }));


    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch finding details' });
  }
});

// 5. Status Distribution (Pie Chart)
app.get('/api/finding-status-distribution', async (req, res) => {
  const { auditTypes, auditCountries } = req.query;

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const selectedTypes = auditTypes ? auditTypes.split(',') : null;
    const selectedCountries = auditCountries ? auditCountries.split(',') : null;

    const statusCounts = {};
    issues.forEach(issue => {
      const typeField = issue.fields.customfield_19767;
      const auditType = typeof typeField === 'object' && typeField?.value ? typeField.value : 'Unassigned';
      const countryField = issue.fields.customfield_19769;
      const auditCountry = typeof countryField === 'object' && countryField?.value ? countryField.value : 'Unassigned';

      if (selectedTypes && !selectedTypes.includes(auditType)) return;
      if (selectedCountries && !selectedCountries.includes(auditCountry)) return;

      const status = issue.fields.status.name;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    res.json(statusCounts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status distribution' });
  }
});


// 6. Horizontal Risk View (Text-Based)
app.get('/api/risk-scale-horizontal', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const data = {};
    issues.forEach(issue => {
      const project = issue.fields.customfield_12126 || 'Unknown Project';
      const risk = issue.fields.customfield_12557?.value || 'Unknown Risk';

      if (!data[project]) data[project] = { Critical: 0, High: 0, Medium: 0, Low: 0 };
      if (['Critical', 'High', 'Medium', 'Low'].includes(risk)) {
        data[project][risk]++;
      }
    });

    res.json(data);
  } catch (error) {
    console.error('Horizontal risk scale fetch error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch horizontal risk scale data' });
  }
});

// 7. Internal Control Element × Risk Level Table
app.get('/api/statistics-by-control-and-risk', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = {};
    const riskLevels = ['Critical', 'High', 'Medium', 'Low'];
    const controlElements = new Set();

    issues.forEach(issue => {
      const controlField = issue.fields.customfield_19635;
const control = typeof controlField === 'object' && controlField?.value ? controlField.value : 'Unassigned';

      const risk = issue.fields.customfield_12557?.value || 'Unassigned';

      controlElements.add(control);

      if (!result[control]) result[control] = {};
      if (!result[control][risk]) result[control][risk] = 0;
      result[control][risk]++;
    });

    const finalData = Array.from(controlElements).map(control => {
      const row = { control };
      let total = 0;

      riskLevels.forEach(level => {
        const count = result[control]?.[level] || 0;
        row[level] = count;
        total += count;
      });

      row.Total = total;
      return row;
    });

    // Totals Row
    const totals = { control: 'Total Unique Issues:' };
    let grandTotal = 0;
    riskLevels.forEach(level => {
      const sum = finalData.reduce((acc, row) => acc + (row[level] || 0), 0);
      totals[level] = sum;
      grandTotal += sum;
    });
    totals.Total = grandTotal;
    finalData.push(totals);

    res.json(finalData);
  } catch (error) {
    console.error('Failed to fetch control-risk statistics:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch statistics by control and risk' });
  }
});
// 8. Findings filtered by Control and Risk
app.get('/api/statistics-by-control-and-risk', async (req, res) => {
  try {
    const selectedStatus = req.query.status;
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = {};
    const riskLevels = ['Critical', 'High', 'Medium', 'Low'];
    const controlElements = new Set();

    issues.forEach(issue => {
      const issueStatus = issue.fields.status?.name;
      if (selectedStatus && issueStatus !== selectedStatus) return; // filtre varsa uygula

      const controlField = issue.fields.customfield_19635;
      const control = typeof controlField === 'object' && controlField?.value ? controlField.value : 'Unassigned';
      const risk = issue.fields.customfield_12557?.value || 'Unassigned';

      controlElements.add(control);

      if (!result[control]) result[control] = {};
      if (!result[control][risk]) result[control][risk] = 0;
      result[control][risk]++;
    });

    const finalData = Array.from(controlElements).map(control => {
      const row = { control };
      let total = 0;

      riskLevels.forEach(level => {
        const count = result[control]?.[level] || 0;
        row[level] = count;
        total += count;
      });

      row.Total = total;
      return row;
    });

    const totals = { control: 'Total Unique Issues:' };
    let grandTotal = 0;
    riskLevels.forEach(level => {
      const sum = finalData.reduce((acc, row) => acc + (row[level] || 0), 0);
      totals[level] = sum;
      grandTotal += sum;
    });
    totals.Total = grandTotal;
    finalData.push(totals);

    res.json(finalData);
  } catch (error) {
    console.error('Failed to fetch control-risk statistics:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch statistics by control and risk' });
  }
});


app.get('/api/statistics-by-type-and-risk', async (req, res) => {
  try {
    const selectedStatus = req.query.status;
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = {};
    const riskLevels = ['Critical', 'High', 'Medium', 'Low'];
    const riskTypes = new Set();

    issues.forEach(issue => {
      const issueStatus = issue.fields.status?.name;
      if (selectedStatus && issueStatus !== selectedStatus) return; // filtre varsa uygula

      const typeField = issue.fields.customfield_19636;
      const type = typeof typeField === 'object' && typeField?.value ? typeField.value : 'Unassigned';
      const risk = issue.fields.customfield_12557?.value || 'Unassigned';

      riskTypes.add(type);

      if (!result[type]) result[type] = {};
      if (!result[type][risk]) result[type][risk] = 0;
      result[type][risk]++;
    });

    const finalData = Array.from(riskTypes).map(type => {
      const row = { type };
      let total = 0;

      riskLevels.forEach(level => {
        const count = result[type]?.[level] || 0;
        row[level] = count;
        total += count;
      });

      row.Total = total;
      return row;
    });

    const totals = { type: 'Total Unique Issues:' };
    let grandTotal = 0;
    riskLevels.forEach(level => {
      const sum = finalData.reduce((acc, row) => acc + (row[level] || 0), 0);
      totals[level] = sum;
      grandTotal += sum;
    });
    totals.Total = grandTotal;
    finalData.push(totals);

    res.json(finalData);
  } catch (error) {
    console.error('Failed to fetch statistics by type and risk:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch statistics by type and risk' });
  }
});


// 9. Findings filtered by Type and Risk
app.get('/api/finding-details-by-type-and-risk', async (req, res) => {
  const { type, risk } = req.query;
  if (!type || !risk) return res.status(400).json({ error: 'Missing type or risk parameter' });

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = issues.filter(issue => {
      const typeField = issue.fields.customfield_19636;
      const typeVal = typeof typeField === 'object' && typeField?.value ? typeField.value : 'Unassigned';
      const riskVal = issue.fields.customfield_12557?.value || 'Unassigned';
      return typeVal === type && riskVal === risk;
    }).map(issue => ({
      key: issue.key,
      summary: issue.fields.summary
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filtered findings by type and risk' });
  }
});

// 10. Audit Types – Jira'daki dropdown'dan unique audit type listesi getir
app.get('/api/audit-types', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const types = new Set();
    issues.forEach(issue => {
      const typeField = issue.fields.customfield_19767;
      const type = typeof typeField === 'object' && typeField?.value ? typeField.value : null;
      if (type) types.add(type);
    });

    res.json(Array.from(types).sort());
  } catch (error) {
    console.error('Failed to fetch audit types:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch audit types' });
  }
});

// === Yeni API: Benzersiz Country değerlerini getir ===
app.get('/api/audit-countries', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const countries = new Set();
    issues.forEach(issue => {
      const countryField = issue.fields.customfield_19769;
      const country = typeof countryField === 'object' && countryField?.value ? countryField.value : null;
      if (country) countries.add(country);
    });

    res.json(Array.from(countries).sort());
  } catch (error) {
    console.error('Failed to fetch audit countries:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch audit countries' });
  }
});

// === Yeni API: Finding Action - Status Distribution ===
app.get('/api/finding-action-status-distribution', async (req, res) => {
  const { auditTypes } = req.query;

  try {
    const jql = `project = ${PROJECT_KEY} AND (issuetype = "Audit Finding" OR issuetype = "Finding Action")`;
    const issues = await getAllIssues(jql);

    const selectedTypes = auditTypes ? auditTypes.split(',') : null;

    const findings = issues.filter(issue => issue.fields.issuetype.name === 'Audit Finding');
    const actions = issues.filter(issue => issue.fields.issuetype.name === 'Finding Action');

    const findingMap = {};
    findings.forEach(f => {
      findingMap[f.key] = f;
    });

    const statusCounts = {};
    actions.forEach(action => {
      const parentKey = action.fields.parent?.key;
      const parentFinding = findingMap[parentKey];
      const parentType = parentFinding?.fields?.customfield_19767?.value || null;

      if (selectedTypes && !selectedTypes.includes(parentType)) return;

      const status = action.fields.status.name;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    res.json(statusCounts);
  } catch (error) {
    console.error('Finding action distribution error:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch finding action status distribution' });
  }
});

// Yeni API: Finding Actions - Status by Audit Lead (Short Text Version)
app.get('/api/finding-action-status-by-lead', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Finding Action"`;
    const issues = await getAllIssues(jql);

    const result = {};

    issues.forEach(issue => {
      // Yeni short text field'dan lead'i alıyoruz
      const lead = issue.fields.customfield_19770 || 'Unassigned';
      const status = issue.fields.status?.name || 'Unknown';

      if (!result[lead]) result[lead] = {};
      if (!result[lead][status]) result[lead][status] = 0;
      result[lead][status]++;
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching status by audit lead:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch status by audit lead' });
  }
});

/// ✅ Yeni API alias: /api/yearly-audit-plan (updated for IAP2)
app.get('/api/yearly-audit-plan', async (req, res) => {
  const NEW_PROJECT_KEY = 'IAP2';  // Yeni proje anahtarı

  try {
    const jql = `project = ${NEW_PROJECT_KEY} AND issuetype = "Task" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    console.log("🚀 Toplam issue sayısı:", issues.length);

    const statusMap = {
      'Planned': 1,
      'Fieldwork': 2,
      'Pre Closing Meeting': 3,
      'Closing Meeting': 4,
      'Completed': 5
    };

    const result = issues.map(issue => {
      const status = issue.fields.status?.name || 'Unknown';
      const currentLevel = statusMap[status] || 0;

      console.log("🔍 Statü:", status);

      const auditLead = issue.fields.customfield_20106 || 'Unassigned'; // short text field

      return {
        key: issue.key,
        summary: issue.fields.summary,
        auditYear: typeof issue.fields.customfield_16447 === 'object'
          ? issue.fields.customfield_16447?.value
          : issue.fields.customfield_16447 || 'Unknown',
        auditLead,
        progressLevel: currentLevel,
        statusLabel: status
      };
    });

    console.log("📊 Filtered Audit Plan Results:", result);

    res.json(result);
  } catch (error) {
    console.error('❌ Error fetching Yearly Audit Plan data:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Yearly Audit Plan data' });
  }
});




app.get('/api/finding-action-age-summary', async (req, res) => {
  try {
    const leadFilter = req.query.lead;

    const jql = `project = ${PROJECT_KEY} AND issuetype = "Finding Action"`;
    const issues = await getAllIssues(jql);

    function resetTime(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    const now = resetTime(new Date());

    const result = {
      '-720–-360': 0,
      '-360–-180': 0,
      '-180–-90': 0,
      '-90–-30': 0,
      '-30–0': 0,
      '0–30': 0,
      '30–90': 0,
      '90–180': 0,
      '180–360': 0,
      '360–720': 0,
      '720+': 0
    };

    issues.forEach(issue => {
      // Lead filtresi uygula
      if (leadFilter) {
        const leadField = issue.fields.customfield_19770;
        const leadValue = typeof leadField === 'string' ? leadField.trim() : '';
        if (leadValue !== leadFilter) return;
      }

      const status = issue.fields.status?.name?.toUpperCase();
      if (!['OPEN', 'OVERDUE'].includes(status)) return;

      const dueDateStr = issue.fields.duedate;
      if (!dueDateStr) return;

      const dueDate = resetTime(new Date(dueDateStr));
      const ageDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));

      let bucket = null;
      if (ageDays <= -360 && ageDays > -720) bucket = '-720–-360';
      else if (ageDays <= -180 && ageDays > -360) bucket = '-360–-180';
      else if (ageDays <= -90 && ageDays > -180) bucket = '-180–-90';
      else if (ageDays <= -30 && ageDays > -90) bucket = '-90–-30';
      else if (ageDays <= 0 && ageDays > -30) bucket = '-30–0';
      else if (ageDays <= 30) bucket = '0–30';
      else if (ageDays <= 90) bucket = '30–90';
      else if (ageDays <= 180) bucket = '90–180';
      else if (ageDays <= 360) bucket = '180–360';
      else if (ageDays <= 720) bucket = '360–720';
      else bucket = '720+';

      if (bucket) result[bucket]++;
    });

    res.json(result);
  } catch (error) {
    console.error('Error generating action age summary:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate action age summary' });
  }
});

app.get('/api/finding-action-age-summary-delayed', async (req, res) => {
  try {
    const leadFilter = req.query.lead;

    const jql = `project = ${PROJECT_KEY} AND issuetype = "Finding Action"`;
    const issues = await getAllIssues(jql);

    function resetTime(date) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    const now = resetTime(new Date());

    const result = {
      '-720–-360': 0,
      '-360–-180': 0,
      '-180–-90': 0,
      '-90–-30': 0,
      '-30–0': 0,
      '0–30': 0,
      '30–90': 0,
      '90–180': 0,
      '180–360': 0,
      '360–720': 0,
      '720+': 0
    };

    issues.forEach(issue => {
      // 🎯 Lead filtresi
      if (leadFilter) {
        const leadField = issue.fields.customfield_19770;
        const leadValue = typeof leadField === 'string' ? leadField.trim() : '';
        if (leadValue !== leadFilter) return;
      }

      // 🎯 Sadece DELAYED
      const status = issue.fields.status?.name?.toUpperCase();
      if (status !== 'DELAYED') return;

      const revisedDueDateStr = issue.fields.customfield_12129;
      if (!revisedDueDateStr) return;

      const revisedDueDate = resetTime(new Date(revisedDueDateStr));
      const ageDays = Math.floor((now - revisedDueDate) / (1000 * 60 * 60 * 24));

      let bucket = null;
      if (ageDays <= -360 && ageDays > -720) bucket = '-720–-360';
      else if (ageDays <= -180 && ageDays > -360) bucket = '-360–-180';
      else if (ageDays <= -90 && ageDays > -180) bucket = '-180–-90';
      else if (ageDays <= -30 && ageDays > -90) bucket = '-90–-30';
      else if (ageDays <= 0 && ageDays > -30) bucket = '-30–0';
      else if (ageDays <= 30) bucket = '0–30';
      else if (ageDays <= 90) bucket = '30–90';
      else if (ageDays <= 180) bucket = '90–180';
      else if (ageDays <= 360) bucket = '180–360';
      else if (ageDays <= 720) bucket = '360–720';
      else bucket = '720+';

      if (bucket) result[bucket]++;
    });

    res.json(result);
  } catch (error) {
    console.error('Error generating delayed action age summary:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to generate delayed action age summary' });
  }
});

app.get('/api/investigation-counts', async (req, res) => {
  const ICT_PROJECT_KEY = 'ICT';

  try {
    const jql = `project = ${ICT_PROJECT_KEY} AND issuetype = "Investigation" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const investigations = issues.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary,
      year: typeof issue.fields.customfield_19899 === 'object'
        ? issue.fields.customfield_19899?.value
        : issue.fields.customfield_19899 || 'Unknown',
      count: issue.fields.customfield_19900 || 0
    }));

    res.json(investigations);
  } catch (error) {
    console.error('Error fetching Investigation data:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch Investigation data.' });
  }
});

// Yeni API: Risk dağılımı – Audit Project bazlı
app.get('/api/finding-risk-distribution-by-project', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const riskLevels = ['Critical', 'High', 'Medium', 'Low'];
    const result = {};

    issues.forEach(issue => {
      const projectName = issue.fields.customfield_12126 || 'Unassigned';
      const auditYearRaw = issue.fields.customfield_16447;
      const auditYear = typeof auditYearRaw === 'object' ? auditYearRaw?.value : (auditYearRaw || 'Unknown');
      const risk = issue.fields.customfield_12557?.value || 'Unassigned';



      const key = `${projectName}___${auditYear}`;  // unique key

      if (!result[key]) {
        result[key] = {
          project: projectName,
          year: auditYear,

          Critical: 0, High: 0, Medium: 0, Low: 0
        };
      }

      if (riskLevels.includes(risk)) {
        result[key][risk]++;
      }
    });

    const formatted = Object.values(result);

    res.json(formatted);
  } catch (error) {
    console.error('Error in finding-risk-distribution-by-project:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch risk distribution by project' });
  }
});


// Yeni API: Finding Actions - Grouped by Audit Name and Status
app.get('/api/finding-actions-by-audit-name-and-status', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Finding Action"`;
    const issues = await getAllIssues(jql);

    const result = [];

    issues.forEach(issue => {
      const auditName = issue.fields.customfield_12126 || 'Unassigned';
const auditYear = issue.fields.customfield_16447?.value || 'Unknown';
      const status = issue.fields.status?.name || 'Unknown';

      // Aynı Audit Name ve Audit Year kombinasyonuna sahip bir kayıt var mı?
      let record = result.find(r => r.auditName === auditName && r.auditYear === auditYear);
      if (!record) {
        record = { auditName, auditYear };
        result.push(record);
      }

      record[status] = (record[status] || 0) + 1;
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching actions by audit name and status:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch data grouped by audit name and status' });
  }
});


app.get('/api/unique-audit-projects-by-year', async (req, res) => {
  const PROJECT_KEY = 'IAP2'; // Yeni proje anahtarı

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Task"`;
    const issues = await getAllIssues(jql);

    const yearCountMap = {};

    issues.forEach(issue => {
      const yearRaw = issue.fields.customfield_16447;
      const year = typeof yearRaw === 'object' && yearRaw?.value
        ? yearRaw.value
        : yearRaw || 'Unknown';

      if (!yearCountMap[year]) {
        yearCountMap[year] = 0;
      }

      yearCountMap[year]++;
    });

    const result = Object.entries(yearCountMap).map(([year, count]) => ({
      year,
      count
    })).sort((a, b) => b.year.localeCompare(a.year)); // Yıl azalan sırada

    res.json(result);
  } catch (err) {
    console.error('Error fetching audit project count:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/google-sheet-data', async (req, res) => {
  try {
    const authClient = await auth.getClient();

    const response = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: '1Tk1X0b_9YvtCdF783SkbsSoqAe-QULhQ_3ud3py1MAc', // yeni sheet ID
      range: 'Getir Data!B133:G142',
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data found in the sheet' });
    }

    res.json({ result: rows });
  } catch (error) {
    console.error('Google Sheet API error:', error);
    res.status(500).json({ error: 'Failed to fetch Google Sheet data' });
  }
});


app.get('/api/fraud-impact-local', async (req, res) => {
  try {
    const authClient = await auth.getClient();

    const response = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: '1Tk1X0b_9YvtCdF783SkbsSoqAe-QULhQ_3ud3py1MAc',
      range: 'Getir Data!B145:G154',
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data found in the sheet' });
    }

    res.json({ result: rows });
  } catch (error) {
    console.error('Google Sheet API error:', error);
    res.status(500).json({ error: 'Failed to fetch Google Sheet data' });
  }
});



app.get('/api/login-credentials', async (req, res) => {
  try {
    const authClient = await auth.getClient();

    const response = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: '1Tk1X0b_9YvtCdF783SkbsSoqAe-QULhQ_3ud3py1MAc',
      range: "'LoginData'!A1:B1", // Yeni adla tam ve güvenli tanım
    });

    const [row] = response.data.values;

    if (!row || row.length < 2) {
      return res.status(404).json({ error: 'Username or password not found' });
    }

    const [username, password] = row;

    res.json({ username, password });
  } catch (error) {
    console.error('Login API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/loss-prevention-summary', async (req, res) => {
  try {
    const authClient = await auth.getClient();

    const response = await sheets.spreadsheets.values.get({
      auth: authClient,
      spreadsheetId: '1LWMD85QjLj7lrT2c8qg6qe62wLoO1UpjSW2qEsn0jPA',
      range: `'2025 Özet'!A62:D69`,
    });

    const rows = response.data.values;

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'No data found in the sheet' });
    }

    res.json({ result: rows });
  } catch (error) {
    console.error('Loss Prevention API Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/fraud-impact-score-cards', async (req, res) => {
  try {
    const doc = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: '1Tk1X0b_9YvtCdF783SkbsSoqAe-QULhQ_3ud3py1MAc',
      ranges: [
        'Getir Data!B133', // year1
        'Getir Data!C133', // year2
        'Getir Data!D133', // year3
        'Getir Data!E133', // year4
        'Getir Data!F133', // year5
        'Getir Data!B142', // impact1
        'Getir Data!C142', // impact2
        'Getir Data!D142', // impact3
        'Getir Data!E142', // impact4
        'Getir Data!F142', // impact5
      ],
    });

    const valueRanges = doc.data.valueRanges;

    if (!valueRanges || valueRanges.length !== 10) {
      return res.status(500).json({ error: `Beklenen 10 hücre, ancak gelen: ${valueRanges?.length}` });
    }

    // Yıl değerleri
    const year1 = valueRanges[0].values?.[0]?.[0] || null;
    const year2 = valueRanges[1].values?.[0]?.[0] || null;
    const year3 = valueRanges[2].values?.[0]?.[0] || null;
    const year4 = valueRanges[3].values?.[0]?.[0] || null;
    const year5 = valueRanges[4].values?.[0]?.[0] || null;

    // Impact değerleri
    const impact1 = valueRanges[5].values?.[0]?.[0] || null;
    const impact2 = valueRanges[6].values?.[0]?.[0] || null;
    const impact3 = valueRanges[7].values?.[0]?.[0] || null;
    const impact4 = valueRanges[8].values?.[0]?.[0] || null;
    const impact5 = valueRanges[9].values?.[0]?.[0] || null;

    const scoreCards = [
      { year: year1, impact: impact1 },
      { year: year2, impact: impact2 },
      { year: year3, impact: impact3 },
      { year: year4, impact: impact4 },
      { year: year5, impact: impact5 },
    ];

    res.json({ scoreCards });

  } catch (error) {
    console.error('Fraud Impact Score Cards Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// new api to be added into getir github

app.get('/api/lp-impact-score-cards', async (req, res) => {
  try {
    const doc = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: '1LWMD85QjLj7lrT2c8qg6qe62wLoO1UpjSW2qEsn0jPA',
      ranges: [
        '2025 Özet!B62', // year1
         '2025 Özet!C62', // year2
         '2025 Özet!D62', // year3
         '2025 Özet!E62', // year4
         '2025 Özet!F62', // year5
         '2025 Özet!B69', // impact1
        '2025 Özet!C69', // impact2
        '2025 Özet!D69', // impact3
        '2025 Özet!E69', // impact4
        '2025 Özet!F69', // impact5
      ],
    });

    const valueRanges = doc.data.valueRanges;

    if (!valueRanges || valueRanges.length !== 10) {
      return res.status(500).json({ error: `Beklenen 10 hücre, ancak gelen: ${valueRanges?.length}` });
    }

    // Yıl değerleri
    const year1 = valueRanges[0].values?.[0]?.[0] || null;
    const year2 = valueRanges[1].values?.[0]?.[0] || null;
    const year3 = valueRanges[2].values?.[0]?.[0] || null;
    const year4 = valueRanges[3].values?.[0]?.[0] || null;
    const year5 = valueRanges[4].values?.[0]?.[0] || null;

    // Impact değerleri
    const impact1 = valueRanges[5].values?.[0]?.[0] || null;
    const impact2 = valueRanges[6].values?.[0]?.[0] || null;
    const impact3 = valueRanges[7].values?.[0]?.[0] || null;
    const impact4 = valueRanges[8].values?.[0]?.[0] || null;
    const impact5 = valueRanges[9].values?.[0]?.[0] || null;

    const scoreCards = [
      { year: year1, impact: impact1 },
      { year: year2, impact: impact2 },
      { year: year3, impact: impact3 },
      { year: year4, impact: impact4 },
      { year: year5, impact: impact5 },
    ];

    res.json({ scoreCards });

  } catch (error) {
    console.error('LP Impact Score Cards Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// yeni api -- getire ekle

app.get('/api/audit-projects-by-year', async (req, res) => {
  const PROJECT_KEY = 'IAP2';
  const VALID_STATUSES = ['Pre Closing Meeting', 'Closing Meeting', 'Completed'];

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = Task AND status in (${VALID_STATUSES.map(s => `"${s}"`).join(', ')}) ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const grouped = {};

    issues.forEach(issue => {
      const yearRaw = issue.fields.customfield_16447;
      const year = typeof yearRaw === 'object' ? yearRaw?.value : (yearRaw || 'Unknown');
      const key = issue.key;

      if (!grouped[year]) grouped[year] = new Set();
      grouped[year].add(key); // Aynı audit key birden fazla varsa bile sadece bir kez say
    });

    const result = Object.entries(grouped).map(([year, set]) => ({
      auditYear: year,
      count: set.size
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching audit projects by year:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch audit projects by year' });
  }
});

// yeni api excel export icin

app.get('/api/finding-actions-export', async (req, res) => {
  try {
    // Audit Finding'leri al (sadece status = Open)
    const findingJQL = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" AND status = "Open" ORDER BY created DESC`;
    const findingIssues = await getAllIssues(findingJQL);

    // Key bazlı map oluştur
    const auditFindingMap = {};
    findingIssues.forEach(issue => {
      const key = issue.key;
      auditFindingMap[key] = {
        auditKey: key,
        auditSummary: issue.fields.summary || '',
        description: issue.fields.description || '',
        status: issue.fields.status?.name || ''
      };
    });

    // Finding Action'ları al (status = Open, Overdue, Completed)
    const actionJQL = `project = ${PROJECT_KEY} AND issuetype = "Finding Action" AND status in ("Open", "Overdue", "DELAYED") ORDER BY created DESC`;
    const actionIssues = await getAllIssues(actionJQL);

    // Audit Finding ile eşleşen action'ları işleyip export için formatla
    const results = [];

    actionIssues.forEach(issue => {
      const parentKey = issue.fields.parent?.key;
      const auditData = auditFindingMap[parentKey];

      if (auditData) {
        results.push({
           auditName: issue.fields.customfield_12126 || '',       
          auditYear: issue.fields.customfield_16447?.value || '',
          ...auditData,

          actionSummary: issue.fields.summary || '',
          actionDescription: issue.fields.description || '',
          actionStatus: issue.fields.status?.name || '',
          dueDate: issue.fields.duedate || '',
          revisedDueDate: issue.fields.customfield_12129 || '',
          actionResponsible: issue.fields.customfield_12556 || '',
          actionResponsibleEmail: issue.fields.customfield_19645 || '',
      
      
        });
      }
    });

    res.json(results);
  } catch (error) {
    console.error("Export API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ✅ YENİ EKLENEN API: Kontrol Elementi ve Riske Göre Bilet Detayları
app.get('/api/finding-details-by-control-and-risk', async (req, res) => {
  const { control, risk } = req.query;
  if (!control || !risk) {
    return res.status(400).json({ error: 'Missing control or risk parameter' });
  }

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = issues.filter(issue => {
      // Gelen 'control' ve 'risk' değerlerine göre filtrele
      const controlField = issue.fields.customfield_19635;
      const controlVal = typeof controlField === 'object' && controlField?.value ? controlField.value : 'Unassigned';
      const riskVal = issue.fields.customfield_12557?.value || 'Unassigned';
      return controlVal === control && riskVal === risk;
    }).map(issue => ({
      // Sadece 'key' ve 'summary' alanlarını al
      key: issue.key,
      summary: issue.fields.summary
    }));

    // Sonucu JSON olarak gönder
    res.json(result);

  } catch (error) {
    console.error('Failed to fetch filtered findings by control and risk:', error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch filtered findings by control and risk' });
  }
});





app.get(/(.*)/, (req, res) => {
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'));
});

// Server Start
app.listen(PORT, () => {
  console.log(`✅ Jira API Backend running at http://localhost:${PORT}`);
});

