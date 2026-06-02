#!/usr/bin/env node

/**
 * Fetch LeetCode Top 100 Liked + Top Interview 150 problems,
 * deduplicate, and save to problems.json
 */

const https = require('https');

function graphql(query, variables = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables });
    const url = new URL('https://leetcode.com/graphql');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://leetcode.com/problemset/',
        'Origin': 'https://leetcode.com',
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}\nStatus: ${res.statusCode}\nBody: ${body.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Query for problem lists (e.g. Top 100 Liked)
const PROBLEMSET_QUERY = `
query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
  problemsetQuestionList: questionList(
    categorySlug: $categorySlug
    limit: $limit
    skip: $skip
    filters: $filters
  ) {
    total: totalNum
    questions: data {
      questionFrontendId
      title
      titleSlug
    }
  }
}
`;

// Query for study plans (e.g. Top Interview 150)
const STUDY_PLAN_QUERY = `
query studyPlanV2Detail($planSlug: String!) {
  studyPlanV2Detail(planSlug: $planSlug) {
    name
    planSubGroups {
      name
      questions {
        questionFrontendId
        title
        titleSlug
      }
    }
  }
}
`;

async function fetchByListId(listId) {
  console.log(`Fetching problem list: "${listId}" ...`);
  const allProblems = [];
  let skip = 0;
  const limit = 100;
  let total = 0;

  while (true) {
    const result = await graphql(PROBLEMSET_QUERY, {
      categorySlug: '',
      limit,
      skip,
      filters: { listId },
    });

    const data = result?.data?.problemsetQuestionList;
    if (!data || !data.questions) {
      console.log(`  Error:`, JSON.stringify(result).slice(0, 300));
      return null;
    }

    if (allProblems.length === 0) total = data.total;
    for (const q of data.questions) {
      if (q.questionFrontendId) {
        allProblems.push({
          id: parseInt(q.questionFrontendId, 10),
          title: q.title,
          slug: q.titleSlug,
        });
      }
    }
    console.log(`  Progress: ${allProblems.length}/${total} ...`);
    if (allProblems.length >= total) break;
    skip += limit;
  }
  console.log(`  ✓ Got ${allProblems.length} problems`);
  return allProblems;
}

async function fetchStudyPlan(planSlug) {
  console.log(`Fetching study plan: "${planSlug}" ...`);
  const result = await graphql(STUDY_PLAN_QUERY, { planSlug });

  const plan = result?.data?.studyPlanV2Detail;
  if (!plan) {
    console.log(`  Error:`, JSON.stringify(result).slice(0, 300));
    return null;
  }

  const allProblems = [];
  for (const group of (plan.planSubGroups || [])) {
    for (const q of (group.questions || [])) {
      if (q.questionFrontendId) {
        allProblems.push({
          id: parseInt(q.questionFrontendId, 10),
          title: q.title,
          slug: q.titleSlug,
        });
      }
    }
  }
  console.log(`  ✓ Got ${allProblems.length} problems from study plan "${plan.name || planSlug}"`);
  return allProblems;
}

async function main() {
  console.log('=== LeetCode Problem Fetcher ===\n');

  // Fetch Top 100 Liked (regular problem list)
  const top100 = await fetchByListId('top-100-liked-questions');

  // Fetch Top Interview 150 (study plan)
  const top150 = await fetchStudyPlan('top-interview-150');

  if (!top100 && !top150) {
    console.error('Failed to fetch any problem lists.');
    process.exit(1);
  }

  // Combine and deduplicate by problem ID
  const seen = new Map();
  const sourceMap = new Map();
  const sets = [];

  if (top100) {
    sets.push({ name: 'top-100-liked', problems: top100 });
    for (const p of top100) {
      seen.set(p.id, p);
      sourceMap.set(p.id, ['Top 100']);
    }
  }

  if (top150) {
    sets.push({ name: 'top-interview-150', problems: top150 });
    for (const p of top150) {
      if (seen.has(p.id)) {
        sourceMap.get(p.id).push('Top 150');
      } else {
        seen.set(p.id, p);
        sourceMap.set(p.id, ['Top 150']);
      }
    }
  }

  const deduped = Array.from(seen.values()).sort((a, b) => a.id - b.id);

  // Tag each problem with its source
  const problemsWithTags = deduped.map(p => {
    const tags = sourceMap.get(p.id) || [];
    return {
      id: p.id,
      title: p.title,
      slug: p.slug,
      in: tags,
    };
  });

  // Output summary
  console.log('\n=== Summary ===');
  for (const s of sets) {
    console.log(`  ${s.name}: ${s.problems.length} problems`);
  }
  console.log(`  Combined unique: ${deduped.length} problems`);
  console.log(`  Overlap (in both): ${problemsWithTags.filter(p => p.in.length > 1).length} problems`);

  // Write to file
  const fs = require('fs');
  const path = require('path');
  const outPath = path.join(__dirname, 'problems.json');

  const output = {
    meta: {
      totalTop100: top100?.length || 0,
      totalTop150: top150?.length || 0,
      totalUnique: deduped.length,
      overlap: problemsWithTags.filter(p => p.in.length > 1).length,
      sources: sets.map(s => s.name),
    },
    problems: problemsWithTags,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`\nSaved to: ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
