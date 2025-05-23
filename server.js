require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = 3000;

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

    const selectedTypes = auditTypes ? auditTypes.split(',') : null;
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
app.get('/api/finding-details-by-control-and-risk', async (req, res) => {
  const { control, risk } = req.query;
  if (!control || !risk) return res.status(400).json({ error: 'Missing control or risk parameter' });

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = issues.filter(issue => {
      const controlField = issue.fields.customfield_19635;
      const controlVal = typeof controlField === 'object' && controlField?.value ? controlField.value : 'Unassigned';
      const riskVal = issue.fields.customfield_12557?.value || 'Unassigned';
      return controlVal === control && riskVal === risk;
    }).map(issue => ({
      key: issue.key,
      summary: issue.fields.summary
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch filtered findings' });
  }
});

app.get('/api/statistics-by-type-and-risk', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const result = {};
    const riskLevels = ['Critical', 'High', 'Medium', 'Low'];
    const riskTypes = new Set();

    issues.forEach(issue => {
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





// Server Start
app.listen(PORT, () => {
  console.log(`✅ Jira API Backend running at http://localhost:${PORT}`);

});
