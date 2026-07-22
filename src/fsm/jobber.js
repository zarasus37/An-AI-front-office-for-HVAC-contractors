/**
 * Jobber GraphQL API Client
 *
 * Implements the Jobber API v3 (GraphQL).
 * Auth: OAuth 2.0 Bearer token. Tokens are per-tenant, stored in env.
 *
 * Jobber GraphQL endpoint: https://api.getjobber.com/graphql
 * Docs: https://developer.getjobber.com/docs
 *
 * Required env vars:
 *   JOBBER_ACCESS_TOKEN  — OAuth 2.0 access token
 *   JOBBER_CLIENT_ID     — OAuth client ID
 *   JOBBER_CLIENT_SECRET — OAuth client secret
 *   (Optional) JOBBER_REFRESH_TOKEN — for token refresh
 */

import { FsmAdapter, FsmError } from './adapter.js';

const JOBBER_GRAPHQL_URL = 'https://api.getjobber.com/graphql';
const JOBBER_TOKEN_URL   = 'https://api.getjobber.com/oauth/access_token';

/**
 * Refresh the Jobber access token using refresh token.
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, expires_in: number }>}
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    client_id:     process.env.JOBBER_CLIENT_ID,
    client_secret: process.env.JOBBER_CLIENT_SECRET,
  });

  const resp = await fetch(JOBBER_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new FsmError(`Jobber token refresh failed: ${resp.status} ${body}`, 'auth', 'jobber');
  }

  return resp.json();
}

// ── GraphQL fetch helper ────────────────────────────────────────────────────────

/**
 * Execute a GraphQL query/mutation against the Jobber API.
 * Handles token refresh on 401.
 *
 * @param {string} query    GraphQL query string
 * @param {object} [variables={}]
 * @param {string} [accessToken]  Override access token (for refresh flow)
 * @returns {Promise<object>}
 */
async function gql(query, variables = {}, accessToken = null) {
  const token = accessToken ?? await _getAccessToken();

  const resp = await fetch(JOBBER_GRAPHQL_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'X-Jobber-App-Version': '2',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (resp.status === 401) {
    // Token expired — try refresh
    const newToken = await _refreshAndCacheAccessToken();
    return gql(query, variables, newToken);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new FsmError(`Jobber API error: ${resp.status} ${body}`, 'network', 'jobber');
  }

  const json = await resp.json();

  if (json.errors?.length) {
    const msg = json.errors.map(e => e.message).join('; ');
    const type = msg.toLowerCase().includes('not found') ? 'not_found' : 'unknown';
    throw new FsmError(`Jobber GraphQL error: ${msg}`, type, 'jobber');
  }

  return json.data;
}

// ── Token management ────────────────────────────────────────────────────────────

/** @type {string|null} */
let _cachedAccessToken = null;
/** @type {number}  Unix ms when token expires */
let _tokenExpiresAt    = 0;

async function _getAccessToken() {
  if (_cachedAccessToken && Date.now() < _tokenExpiresAt - 60_000) {
    return _cachedAccessToken;
  }
  return _refreshAndCacheAccessToken();
}

async function _refreshAndCacheAccessToken() {
  const refreshToken = process.env.JOBBER_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new FsmError(
      'JOBBER_REFRESH_TOKEN not set. Cannot refresh access token.',
      'auth', 'jobber'
    );
  }

  const tokens = await refreshAccessToken(refreshToken);
  _cachedAccessToken = tokens.access_token;
  _tokenExpiresAt    = Date.now() + tokens.expires_in * 1000;
  return _cachedAccessToken;
}

/**
 * Directly set the access token (e.g., after OAuth flow exchange).
 * Skips refresh flow. Useful in tests.
 * @param {string} token
 * @param {number} expiresInSeconds
 */
export function setAccessToken(token, expiresInSeconds = 3600) {
  _cachedAccessToken = token;
  _tokenExpiresAt    = Date.now() + expiresInSeconds * 1000;
}

/**
 * Clear cached token (forces re-fetch on next call).
 */
export function clearAccessToken() {
  _cachedAccessToken = null;
  _tokenExpiresAt    = 0;
}

// ── GraphQL Queries ─────────────────────────────────────────────────────────────

const CUSTOMER_FRAGMENT = `
  fragment CustomerFields on Customer {
    id
    name { first last }
    phones { number type }
    emails { address type }
    address { line1 city province postalCode country }
  }
`;

const FIND_CUSTOMER_QUERY = `
  ${CUSTOMER_FRAGMENT}
  query FindCustomer($phone: String, $email: String) {
    customers(phone: $phone, email: $email, limit: 1) {
      nodes { ...CustomerFields }
    }
  }
`;

const UPSERT_CUSTOMER_MUTATION = `
  ${CUSTOMER_FRAGMENT}
  mutation UpsertCustomer($input: UpsertCustomerInput!) {
    upsertCustomer(input: $input) {
      customer { ...CustomerFields }
      created
    }
  }
`;

const CREATE_JOB_MUTATION = `
  mutation CreateJob($input: CreateJobInput!) {
    createJob(input: $input) {
      job {
        id
        state
        createdAt
      }
    }
  }
`;

const PRICEBOOK_QUERY = `
  query GetPricebookEntries($jobType: String) {
    pricebookEntries(jobType: $jobType) {
      nodes {
        id
        name
        unitCost
        jobType
      }
    }
  }
`;

const CUSTOMER_AGREEMENTS_QUERY = `
  query GetCustomerAgreements($customerId: ID!) {
    customer(id: $customerId) {
      agreements(limit: 10) {
        nodes {
          id
          name
          status
          expiresAt
        }
      }
    }
  }
`;

// ── Mapper functions ────────────────────────────────────────────────────────────

/** Map Jobber customer GraphQL node → FsmAdapter Customer */
function mapCustomer(node) {
  return {
    fsm_id:  node.id,
    name:    node.name ? `${node.name.first ?? ''} ${node.name.last ?? ''}`.trim() : null,
    phone:   node.phones?.[0]?.number ?? null,
    email:   node.emails?.[0]?.address ?? null,
    address: node.address ? [
      node.address.line1,
      node.address.city,
      node.address.province,
      node.address.postalCode,
    ].filter(Boolean).join(', ') : null,
  };
}

/** Map raw Jobber pricebook entry → PricebookEntry */
function mapPricebookEntry(node) {
  return {
    service_name: node.name,
    price:        Number(node.unitCost) || 0,
    job_type:     node.jobType?.toLowerCase() ?? null,
  };
}

/** Map Jobber job creation response → FsmAdapter Job */
function mapJob(node) {
  const stateMap = {
    QUOTED:       'queued',
    SCHEDULED:    'scheduled',
    IN_PROGRESS:  'in_progress',
    COMPLETED:    'completed',
    CANCELLED:    'cancelled',
    ARCHIVED:     'cancelled',
  };
  return {
    fsm_id:  node.id,
    status:  stateMap[node.state?.toUpperCase()] ?? 'queued',
  };
}

// ── JobberAdapter ────────────────────────────────────────────────────────────────

export class JobberAdapter extends FsmAdapter {
  get name() { return 'jobber'; }

  /** @param {object} config — currently unused (reads from env) */
  async initialize(config) {
    const token = process.env.JOBBER_ACCESS_TOKEN;
    if (!token && !process.env.JOBBER_REFRESH_TOKEN) {
      throw new FsmError(
        'JOBBER_ACCESS_TOKEN or JOBBER_REFRESH_TOKEN not set. Cannot initialize Jobber adapter.',
        'auth', 'jobber'
      );
    }
    // Prime the token cache
    if (token) setAccessToken(token);
  }

  async findCustomer(phone, email) {
    try {
      const data = await gql(FIND_CUSTOMER_QUERY, { phone, email: email ?? undefined });
      const nodes = data?.customers?.nodes ?? [];
      return nodes.length > 0 ? mapCustomer(nodes[0]) : null;
    } catch (err) {
      if (err instanceof FsmError) throw err;
      throw new FsmError(`findCustomer failed: ${err.message}`, 'network', 'jobber', err);
    }
  }

  async upsertCustomer({ phone, email, name, address }) {
    // Split name into first/last if provided
    let firstName = null, lastName = null;
    if (name) {
      const parts = name.trim().split(/\s+/);
      firstName = parts[0] ?? null;
      lastName  = parts.slice(1).join(' ') || null;
    }

    const input = {
      phones: phone ? [{ number: phone, type: 'mobile' }] : [],
      emails: email ? [{ address: email, type: 'home' }] : [],
    };
    if (firstName) input.firstName = firstName;
    if (lastName)  input.lastName  = lastName;
    if (address)   input.address   = { line1: address };

    try {
      const data = await gql(UPSERT_CUSTOMER_MUTATION, { input });
      const result = data?.upsertCustomer;
      if (!result?.customer) {
        throw new FsmError('upsertCustomer returned no customer', 'unknown', 'jobber');
      }
      return mapCustomer(result.customer);
    } catch (err) {
      if (err instanceof FsmError) throw err;
      throw new FsmError(`upsertCustomer failed: ${err.message}`, 'network', 'jobber', err);
    }
  }

  async createJob({ customerId, phone, address, description, intent, urgency }) {
    // Map urgency to Jobber job priority
    const priorityMap = {
      emergency: 'URGENT',
      urgent:    'HIGH',
      routine:   'NORMAL',
      low:       'LOW',
    };

    // Build job title from description (Jobber job titles are short)
    const title = description.length > 80 ? description.slice(0, 77) + '...' : description;

    const input = {
      customerId,
      title,
      description,
      priority:    priorityMap[urgency] ?? 'NORMAL',
      // Assign to "Incoming" queue via property or tag
      // Jobber uses "jobQueue" for intake routing
      // This is a Tier 1 push — human dispatches it
    };

    try {
      const data = await gql(CREATE_JOB_MUTATION, { input });
      const job  = data?.createJob?.job;
      if (!job) {
        throw new FsmError('createJob returned no job', 'unknown', 'jobber');
      }
      return mapJob(job);
    } catch (err) {
      if (err instanceof FsmError) throw err;
      throw new FsmError(`createJob failed: ${err.message}`, 'network', 'jobber', err);
    }
  }

  async getPricebookEntry(serviceName, jobType) {
    try {
      const data = await gql(PRICEBOOK_QUERY, { jobType: jobType ?? undefined });
      const nodes = data?.pricebookEntries?.nodes ?? [];

      // Fuzzy match: search name for serviceName keywords
      if (serviceName) {
        const keywords = serviceName.toLowerCase().split(/\s+/);
        const scored  = nodes.map(n => {
          const nameLower = n.name.toLowerCase();
          const score = keywords.filter(k => nameLower.includes(k)).length;
          return { node: n, score };
        }).filter(s => s.score > 0)
          .sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          return mapPricebookEntry(scored[0].node);
        }
      }

      // Fallback: return first entry matching jobType (only if jobType was explicitly provided)
      if (jobType) {
        const matched = nodes.find(n => n.jobType?.toLowerCase() === jobType.toLowerCase());
        if (matched) return mapPricebookEntry(matched);
      }

      return null;
    } catch (err) {
      if (err instanceof FsmError) throw err;
      throw new FsmError(`getPricebookEntry failed: ${err.message}`, 'network', 'jobber', err);
    }
  }

  async getMembership(customerId) {
    try {
      const data = await gql(CUSTOMER_AGREEMENTS_QUERY, { customerId });
      const agreements = data?.customer?.agreements?.nodes ?? [];
      const active = agreements.find(a =>
        a.status !== 'CANCELLED' &&
        a.status !== 'EXPIRED'   &&
        (!a.expiresAt || new Date(a.expiresAt) > new Date())
      );
      if (!active) return null;
      return { plan: active.name, expiresAt: active.expiresAt };
    } catch (err) {
      if (err instanceof FsmError) throw err;
      throw new FsmError(`getMembership failed: ${err.message}`, 'network', 'jobber', err);
    }
  }
}
