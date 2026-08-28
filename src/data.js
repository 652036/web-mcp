import { deepClone } from './engine.js';

const now = () => new Date().toISOString();

export function createBlankWorkspace() {
  return {
    version: 1,
    brief: {
      title: 'Untitled decision',
      question: 'What are we deciding?',
      context: '',
      constraints: '',
    },
    options: [
      { id: 'option-a', name: 'Option A', description: 'Describe the first viable path.' },
      { id: 'option-b', name: 'Option B', description: 'Describe the second viable path.' },
    ],
    criteria: [
      { id: 'criterion-impact', name: 'Impact', description: 'Expected value if this path succeeds.', weight: 50 },
      { id: 'criterion-feasibility', name: 'Feasibility', description: 'Ability to execute with current resources.', weight: 50 },
    ],
    scores: {
      'option-a': {
        'criterion-impact': { score: 5, confidence: 40, evidence: '' },
        'criterion-feasibility': { score: 5, confidence: 40, evidence: '' },
      },
      'option-b': {
        'criterion-impact': { score: 5, confidence: 40, evidence: '' },
        'criterion-feasibility': { score: 5, confidence: 40, evidence: '' },
      },
    },
    assumptions: [],
    scenarios: [],
    activeScenarioId: 'base',
    stagedRecommendation: null,
    committedDecision: null,
    lastStressTest: null,
    activity: [{ id: 'activity-start', at: now(), actor: 'system', text: 'Created a blank decision workspace.' }],
  };
}

const launchWorkspace = {
  version: 1,
  brief: {
    title: 'Launch Atlas Notes',
    question: 'Which launch motion should the team use for Atlas Notes in Q4?',
    context: 'Atlas Notes is a collaborative research notebook with a strong beta cohort. The team needs a launch path that creates credible demand without exhausting a six-person product group.',
    constraints: 'Launch within 10 weeks. Marketing budget is capped at $90k. No more than two engineers can be diverted for launch-specific work.',
  },
  options: [
    { id: 'launch-self-serve', name: 'Self-serve public launch', description: 'Open access, product-led onboarding, and a focused creator campaign.' },
    { id: 'launch-design-partners', name: 'Design-partner rollout', description: 'Expand through 12 carefully supported customer teams before broad release.' },
    { id: 'launch-marketplace', name: 'Marketplace partnership', description: 'Launch through a productivity platform with co-marketing and bundled distribution.' },
  ],
  criteria: [
    { id: 'criterion-learning', name: 'Learning velocity', description: 'How quickly the motion produces reliable product and market insight.', weight: 30 },
    { id: 'criterion-reach', name: 'Qualified reach', description: 'Likely exposure to users with a real need and willingness to adopt.', weight: 25 },
    { id: 'criterion-load', name: 'Team sustainability', description: 'Ability to execute without destabilizing the product roadmap.', weight: 25 },
    { id: 'criterion-revenue', name: 'Revenue signal', description: 'Strength and speed of evidence for willingness to pay.', weight: 20 },
  ],
  scores: {
    'launch-self-serve': {
      'criterion-learning': { score: 8.4, confidence: 72, evidence: 'Beta onboarding funnel is instrumented; 61% of activated users complete a second session.' },
      'criterion-reach': { score: 7.8, confidence: 58, evidence: 'Creator waitlist contains 3,800 sign-ups, but job-to-be-done quality varies.' },
      'criterion-load': { score: 5.2, confidence: 76, evidence: 'Support forecast requires 1.6 FTE during the first three weeks.' },
      'criterion-revenue': { score: 6.1, confidence: 48, evidence: 'Pricing survey is positive, but only 14 paid conversion interviews are complete.' },
    },
    'launch-design-partners': {
      'criterion-learning': { score: 9.1, confidence: 86, evidence: 'Current beta teams provide weekly workflow reviews and detailed retention data.' },
      'criterion-reach': { score: 5.4, confidence: 82, evidence: 'Pipeline has 17 qualified teams; reach is intentionally narrow.' },
      'criterion-load': { score: 6.8, confidence: 70, evidence: 'High-touch onboarding is manageable at 12 teams with rotating office hours.' },
      'criterion-revenue': { score: 8.3, confidence: 78, evidence: 'Nine prospects accepted the proposed annual price range during discovery.' },
    },
    'launch-marketplace': {
      'criterion-learning': { score: 6.2, confidence: 44, evidence: 'Partner would own part of acquisition data, reducing behavioral visibility.' },
      'criterion-reach': { score: 9.0, confidence: 68, evidence: 'Marketplace category receives approximately 120k monthly qualified visits.' },
      'criterion-load': { score: 4.8, confidence: 61, evidence: 'Integration estimate is four to seven engineer-weeks plus certification.' },
      'criterion-revenue': { score: 7.2, confidence: 52, evidence: 'Comparable listings monetize well, but revenue share is still under negotiation.' },
    },
  },
  assumptions: [
    { id: 'assumption-support', text: 'Self-serve support volume will remain below 180 tickets in week one.', impact: 'high', status: 'open' },
    { id: 'assumption-partner', text: 'The marketplace partner will approve co-marketing inventory by the launch window.', impact: 'high', status: 'open' },
    { id: 'assumption-price', text: 'Design partners will convert near the proposed $12k annual contract value.', impact: 'medium', status: 'testing' },
  ],
  scenarios: [
    {
      id: 'scenario-budget-cut',
      name: 'Budget cut',
      description: 'Marketing budget falls to $45k and team sustainability becomes the dominant constraint.',
      weightOverrides: { 'criterion-learning': 24, 'criterion-reach': 16, 'criterion-load': 42, 'criterion-revenue': 18 },
      scoreOverrides: {
        'launch-self-serve': { 'criterion-reach': { score: 6.2, confidence: 62, evidence: 'Reduced paid distribution lowers qualified top-of-funnel.' } },
        'launch-marketplace': { 'criterion-load': { score: 4.1, confidence: 65, evidence: 'Partner integration becomes harder to absorb under the reduced budget.' } },
      },
    },
    {
      id: 'scenario-competitor',
      name: 'Competitor launches first',
      description: 'A well-funded competitor announces a similar notebook six weeks before the target date.',
      weightOverrides: { 'criterion-learning': 22, 'criterion-reach': 38, 'criterion-load': 16, 'criterion-revenue': 24 },
      scoreOverrides: {
        'launch-self-serve': { 'criterion-reach': { score: 8.5, confidence: 64, evidence: 'A public launch can capture comparison traffic and category attention.' } },
        'launch-design-partners': { 'criterion-reach': { score: 4.2, confidence: 84, evidence: 'A narrow rollout risks losing the category narrative.' } },
      },
    },
  ],
  activeScenarioId: 'base',
  stagedRecommendation: null,
  committedDecision: null,
  lastStressTest: null,
  activity: [
    { id: 'activity-example', at: now(), actor: 'system', text: 'Loaded the Atlas Notes product-launch example.' },
  ],
};

const locationWorkspace = {
  version: 1,
  brief: {
    title: 'Choose an APAC support hub',
    question: 'Where should the company establish its next customer-support hub?',
    context: 'A SaaS company needs 16-hour APAC coverage and expects the hub to grow from 18 to 55 people in two years.',
    constraints: 'Operational within nine months. English support is mandatory; Japanese and Mandarin coverage are preferred.',
  },
  options: [
    { id: 'hub-tokyo', name: 'Tokyo', description: 'High customer proximity and deep Japanese-language talent.' },
    { id: 'hub-singapore', name: 'Singapore', description: 'Regional operating base with broad multilingual hiring.' },
    { id: 'hub-kuala-lumpur', name: 'Kuala Lumpur', description: 'Cost-efficient multilingual services market.' },
  ],
  criteria: [
    { id: 'hub-talent', name: 'Talent access', description: 'Depth, language coverage, and hiring speed.', weight: 30 },
    { id: 'hub-customer', name: 'Customer proximity', description: 'Access to priority accounts and regional context.', weight: 25 },
    { id: 'hub-cost', name: 'Operating efficiency', description: 'Total cost at the expected two-year scale.', weight: 25 },
    { id: 'hub-risk', name: 'Execution risk', description: 'Setup complexity, retention, and operational resilience.', weight: 20 },
  ],
  scores: {
    'hub-tokyo': {
      'hub-talent': { score: 7.0, confidence: 66, evidence: 'Recruiter scan shows strong Japanese support talent but a competitive bilingual market.' },
      'hub-customer': { score: 9.2, confidence: 88, evidence: 'Forty-three percent of APAC enterprise revenue is in Japan.' },
      'hub-cost': { score: 4.1, confidence: 83, evidence: 'Compensation and office model are highest among shortlisted cities.' },
      'hub-risk': { score: 6.4, confidence: 61, evidence: 'Entity setup is understood; senior support leadership pipeline is thin.' },
    },
    'hub-singapore': {
      'hub-talent': { score: 8.4, confidence: 78, evidence: 'Multilingual regional support market and strong leadership pipeline.' },
      'hub-customer': { score: 7.8, confidence: 75, evidence: 'Direct access to regional headquarters across Southeast Asia.' },
      'hub-cost': { score: 5.8, confidence: 80, evidence: 'Higher compensation offset by simpler regional operations.' },
      'hub-risk': { score: 8.1, confidence: 82, evidence: 'Existing company entity and mature vendor ecosystem.' },
    },
    'hub-kuala-lumpur': {
      'hub-talent': { score: 8.0, confidence: 69, evidence: 'Strong English and Mandarin services talent; Japanese coverage requires validation.' },
      'hub-customer': { score: 6.1, confidence: 70, evidence: 'Good regional access but fewer priority accounts are local.' },
      'hub-cost': { score: 9.0, confidence: 87, evidence: 'Two-year loaded cost estimate is 38% below Singapore.' },
      'hub-risk': { score: 7.0, confidence: 63, evidence: 'Setup vendors are available; leadership hiring assumptions remain open.' },
    },
  },
  assumptions: [
    { id: 'hub-language', text: 'Kuala Lumpur can supply enough Japanese-language agents within six months.', impact: 'high', status: 'open' },
    { id: 'hub-growth', text: 'The team will reach at least 45 people by the end of year two.', impact: 'medium', status: 'testing' },
  ],
  scenarios: [
    {
      id: 'hub-japan-growth',
      name: 'Japan accelerates',
      description: 'Japan grows to 60% of regional enterprise revenue.',
      weightOverrides: { 'hub-talent': 29, 'hub-customer': 40, 'hub-cost': 13, 'hub-risk': 18 },
      scoreOverrides: { 'hub-tokyo': { 'hub-customer': { score: 9.8, confidence: 91 } } },
    },
  ],
  activeScenarioId: 'base',
  stagedRecommendation: null,
  committedDecision: null,
  lastStressTest: null,
  activity: [{ id: 'activity-location', at: now(), actor: 'system', text: 'Loaded the APAC hub example.' }],
};

export const examples = {
  launch: { label: 'Product launch', workspace: launchWorkspace },
  location: { label: 'APAC support hub', workspace: locationWorkspace },
};

export function getExample(key = 'launch') {
  return deepClone(examples[key]?.workspace ?? launchWorkspace);
}
