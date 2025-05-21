require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = 3000;

app.use(cors());

const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.PROJECT_KEY;

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

  while (true) {
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}`;
    const response = await axios.get(url, authHeader);
    const { issues, total } = response.data;

    allIssues = allIssues.concat(issues);
    if (allIssues.length >= total) break;

    startAt += maxResults;
  }

  return allIssues;
}

app.get('/api/issues', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} ORDER BY created DESC`;
    const issues = await getAllIssues(jql);
    res.json({ issues });
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Jira issues could not be fetched' });
  }
});

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
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch finding summary' });
  }
});

app.get('/api/finding-status-by-year', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const statusByYear = {};

    issues.forEach(issue => {
      const yearValue = issue.fields.customfield_16447;
      const year = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
      const status = issue.fields.status.name;

      if (!statusByYear[year]) statusByYear[year] = {};
      statusByYear[year][status] = (statusByYear[year][status] || 0) + 1;
    });

    res.json(statusByYear);
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate findings by year' });
  }
});

// 🔹 Yıla ve statüye göre veya yalnızca statüye göre detay listesi
app.get('/api/finding-details', async (req, res) => {
  const { year, status } = req.query;

  if (!status) {
    return res.status(400).json({ error: 'Missing status parameter' });
  }

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" ORDER BY created DESC`;
    const issues = await getAllIssues(jql);

    const matching = issues.filter(issue => {
      const yearValue = issue.fields.customfield_16447;
      const issueYear = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
      const normalizedYear = issueYear === 'Unknown' ? 'Not Assigned' : issueYear;
      const issueStatus = issue.fields.status.name;

      if (year === 'all') {
        return issueStatus === status;
      }

      return normalizedYear === year && issueStatus === status;
    });

    const result = matching.map(issue => ({
      key: issue.key,
      summary: issue.fields.summary
    }));

    res.json(result);
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch finding details' });
  }
});

app.get('/api/finding-status-distribution', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding"`;
    const issues = await getAllIssues(jql);

    const statusCounts = {};
    issues.forEach(issue => {
      const status = issue.fields.status.name;
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    res.json(statusCounts);
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch status distribution' });
  }
});

app.listen(PORT, () => {
  console.log(`Jira API Backend running at http://localhost:${PORT}`);
});
