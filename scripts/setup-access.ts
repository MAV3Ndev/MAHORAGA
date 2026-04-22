#!/usr/bin/env npx tsx
/**
 * Cloudflare Access Setup Script
 * 
 * Sets up Cloudflare Access to protect your MAHORAGA worker endpoints.
 * This provides SSO, email verification, or one-time PIN authentication.
 * 
 * Required environment variables:
 *   CLOUDFLARE_API_TOKEN - API token with Access:Edit permissions
 *   CLOUDFLARE_ACCOUNT_ID - Your Cloudflare account ID
 *   MAHORAGA_WORKER_URL - Your worker URL (e.g., https://mahoraga.your-subdomain.workers.dev)
 * 
 * Optional:
 *   MAHORAGA_ALLOWED_EMAILS - Comma-separated list of allowed emails
 * 
 * Usage:
 *   npx tsx scripts/setup-access.ts
 * 
 * Or with environment variables inline:
 *   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy MAHORAGA_WORKER_URL=https://... npx tsx scripts/setup-access.ts
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

interface AccessApplication {
  id: string;
  name: string;
  domain: string;
  type: string;
  session_duration: string;
}

interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  include: Array<{ email?: { email: string }; email_domain?: { domain: string }; everyone?: object }>;
}

interface CloudflareResponse<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

async function cfFetch<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    throw new Error("CLOUDFLARE_API_TOKEN is required");
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const data = (await response.json()) as CloudflareResponse<T>;

  if (!data.success) {
    const errorMsg = data.errors.map((e) => e.message).join(", ");
    throw new Error(`Cloudflare API error: ${errorMsg}`);
  }

  return data.result;
}

async function listAccessApplications(accountId: string): Promise<AccessApplication[]> {
  return cfFetch<AccessApplication[]>(`/accounts/${accountId}/access/apps`);
}

async function createAccessApplication(
  accountId: string,
  name: string,
  domain: string
): Promise<AccessApplication> {
  return cfFetch<AccessApplication>(`/accounts/${accountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name,
      domain,
      type: "self_hosted",
      session_duration: "24h",
      auto_redirect_to_identity: true,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: "lax",
    }),
  });
}

async function createAccessPolicy(
  accountId: string,
  appId: string,
  name: string,
  emails: string[]
): Promise<AccessPolicy> {
  const include: AccessPolicy["include"] = emails.length > 0
    ? emails.map((email) => ({ email: { email } }))
    : [{ everyone: {} }];

  return cfFetch<AccessPolicy>(
    `/accounts/${accountId}/access/apps/${appId}/policies`,
    {
      method: "POST",
      body: JSON.stringify({
        name,
        decision: "allow",
        include,
        require: [],
        exclude: [],
        precedence: 1,
      }),
    }
  );
}

async function enableOTPLogin(accountId: string): Promise<void> {
  try {
    await cfFetch(`/accounts/${accountId}/access/identity_providers`, {
      method: "POST",
      body: JSON.stringify({
        name: "One-Time PIN",
        type: "onetimepin",
        config: {},
      }),
    });
    console.log("✓ One-Time PIN login enabled");
  } catch (error) {
    if (String(error).includes("already exists")) {
      console.log("✓ One-Time PIN login already enabled");
    } else {
      throw error;
    }
  }
}

function extractDomain(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "");
}

async function main() {
  console.log("\n🔐 MAHORAGA Cloudflare Access Setup\n");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const workerUrl = process.env.MAHORAGA_WORKER_URL;
  const allowedEmails = process.env.MAHORAGA_ALLOWED_EMAILS?.split(",").map((e) => e.trim()).filter(Boolean) || [];

  if (!accountId) {
    console.error("❌ CLOUDFLARE_ACCOUNT_ID is required");
    console.error("   Find it at: https://dash.cloudflare.com → Account ID in the sidebar");
    process.exit(1);
  }

  if (!workerUrl) {
    console.error("❌ MAHORAGA_WORKER_URL is required");
    console.error("   Example: https://mahoraga.your-subdomain.workers.dev");
    process.exit(1);
  }

  if (!process.env.CLOUDFLARE_API_TOKEN) {
    console.error("❌ CLOUDFLARE_API_TOKEN is required");
    console.error("   Create one at: https://dash.cloudflare.com/profile/api-tokens");
    console.error("   Required permissions: Account → Access: Organizations, Identity Providers, and Groups → Edit");
    process.exit(1);
  }

  const domain = extractDomain(workerUrl);
  const appName = "MAHORAGA Trading Agent";

  console.log(`Account ID: ${accountId}`);
  console.log(`Worker URL: ${workerUrl}`);
  console.log(`Domain: ${domain}`);
  console.log(`Allowed Emails: ${allowedEmails.length > 0 ? allowedEmails.join(", ") : "(all - using OTP)"}\n`);

  const existingApps = await listAccessApplications(accountId);
  const existingApp = existingApps.find((app) => app.domain === domain);

  if (existingApp) {
    console.log(`✓ Access Application already exists: ${existingApp.name} (${existingApp.id})`);
    console.log(`  Dashboard: https://one.dash.cloudflare.com/${accountId}/access/apps/${existingApp.id}`);
    return;
  }

  console.log("Creating Access Application...");
  await enableOTPLogin(accountId);
  
  const app = await createAccessApplication(accountId, appName, domain);
  console.log(`✓ Created Access Application: ${app.name} (${app.id})`);

  console.log("Creating Access Policy...");
  const policyName = allowedEmails.length > 0 ? "Allowed Users" : "OTP Verification";
  const policy = await createAccessPolicy(accountId, app.id, policyName, allowedEmails);
  console.log(`✓ Created Access Policy: ${policy.name} (${policy.id})`);

  console.log("\n" + "=".repeat(60));
  console.log("✅ Cloudflare Access Setup Complete!\n");
  console.log("Your MAHORAGA endpoints are now protected.");
  console.log(`Dashboard: https://one.dash.cloudflare.com/${accountId}/access/apps/${app.id}`);
  
  if (allowedEmails.length === 0) {
    console.log("\n📧 Authentication: One-Time PIN");
    console.log("   Users will receive an email with a code to access the dashboard.");
    console.log("   To restrict to specific emails, re-run with:");
    console.log("   MAHORAGA_ALLOWED_EMAILS=you@example.com,team@example.com npx tsx scripts/setup-access.ts");
  } else {
    console.log(`\n📧 Authentication: Email allowlist (${allowedEmails.length} users)`);
  }
  
  console.log("\n⚠️  Note: It may take a few minutes for Access to propagate.");
  console.log("=".repeat(60) + "\n");
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
