require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = 3000;

app.use(cors());

const JIRA_DOMAIN = 'https://getirdev.atlassian.net';
const JIRA_EMAIL = 'ahmet.donmez@getir.com';
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = 'FINDINGS';

const authHeader = {
  headers: {
    Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
    Accept: 'application/json'
  }
};

app.get('/api/issues', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} ORDER BY created DESC`;
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100`;
    const response = await axios.get(url, authHeader);
    res.json(response.data);
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Jira issues could not be fetched' });
  }
});

app.get('/api/finding-summary', async (req, res) => {
  try {
    const jql = `project = ${PROJECT_KEY} ORDER BY created DESC`;
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=100`;
    const response = await axios.get(url, authHeader);
    const issues = response.data.issues;

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
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200`;
    const response = await axios.get(url, authHeader);
    const issues = response.data.issues;

    const statusByYear = {};
    const today = new Date();

    issues.forEach(issue => {
      const yearValue = issue.fields.customfield_16447;
      const year = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
      const status = issue.fields.status.name;
      const dueDate = issue.fields.duedate ? new Date(issue.fields.duedate) : null;

      let category;
      if (status.toLowerCase() === 'completed') {
        category = 'Completed';
      } else if (dueDate && dueDate < today) {
        category = 'Overdue';
      } else {
        category = 'Open';
      }

      if (!statusByYear[year]) {
        statusByYear[year] = { Completed: 0, Open: 0, Overdue: 0 };
      }

      statusByYear[year][category]++;
    });

    res.json(statusByYear);
  } catch (error) {
    console.error(error?.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate findings by year' });
  }
});

app.get('/api/finding-details', async (req, res) => {
  const { year, status } = req.query;

  if (!year || !status) {
    return res.status(400).json({ error: 'Missing year or status parameter' });
  }

  try {
    const jql = `project = ${PROJECT_KEY} AND issuetype = "Audit Finding" ORDER BY created DESC`;
    const url = `${JIRA_DOMAIN}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=200`;
    const response = await axios.get(url, authHeader);
    const issues = response.data.issues;
    const today = new Date();

    const matching = issues.filter(issue => {
      const yearValue = issue.fields.customfield_16447;
      const issueYear = typeof yearValue === 'object' && yearValue?.value ? yearValue.value : (yearValue || 'Unknown');
      const normalizedYear = issueYear === 'Unknown' ? 'Not Assigned' : issueYear;

      const issueStatus = issue.fields.status.name;
      const dueDate = issue.fields.duedate ? new Date(issue.fields.duedate) : null;

      let category;
      if (issueStatus.toLowerCase() === 'completed') {
        category = 'Completed';
      } else if (dueDate && dueDate < today) {
        category = 'Overdue';
      } else {
        category = 'Open';
      }

      return (normalizedYear === year) && category === status;
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

app.listen(PORT, () => {
  console.log(`Jira API Backend running at http://localhost:${PORT}`);
});
