/**
 * [W3] The fixture brain the retrieval gate's own tests measure against: five documents, each
 * with one fact under one heading between twelve ordinary sections that share the everyday words
 * of the questions (days, office, notice, employee) without answering them. The shipped ranker
 * puts every fact in its top 8; a ranker returning the reverse order does not, because the lease
 * question relates to thirteen chunks and the fact is then last of them.
 *
 * Test-only, like `ingest/test-fixtures.ts`; nothing in a run imports it.
 */
import fs from "node:fs";
import path from "node:path";

import type { Brain } from "./brain.js";
import { ingestDocuments } from "./ingest/index.js";

const FILLER_TOPICS = ["kitchen", "printers", "meeting rooms", "visitors", "post room", "recycling", "bike storage", "desk booking", "first aid", "wifi", "badges", "dress code"];

function fixtureDoc(title: string, heading: string, fact: string): string {
  const filler = FILLER_TOPICS.map(
    (topic) =>
      `## ${topic[0]!.toUpperCase()}${topic.slice(1)}\nThe ${topic} guidance for the office is reviewed every ninety days by the company and every employee gets notice of a change to the plan by email.`,
  );
  return `# ${title}\n\n${filler.slice(0, 6).join("\n\n")}\n\n## ${heading}\n${fact}\n\n${filler.slice(6).join("\n\n")}`;
}

/** File name to contents. The fact sits in chunk 7 of every document. */
export const RETRIEVAL_FIXTURE_DOCS: Readonly<Record<string, string>> = {
  "lease.md": fixtureDoc("Office lease", "Termination", "Either party may end this office lease agreement with ninety days written notice delivered to the landlord's registered address."),
  "handbook.md": fixtureDoc("Staff handbook", "Holidays", "Every employee receives twenty five days of paid holiday each year, booked through the leave calendar."),
  "refunds.md": fixtureDoc("Refund policy", "Window", "We issue refunds within fourteen days of a cancellation request for any subscription plan."),
  "vendors.md": fixtureDoc("Vendor contracts", "Payroll provider", "The payroll provider files the tax returns and charges four dollars per employee per month."),
  "security.md": fixtureDoc("Security policy", "Laptops", "A lost company laptop is reported to security the same day and wiped remotely before lunch."),
};

export interface RetrievalFixtureQuery {
  readonly id: string;
  readonly query: string;
  readonly expected_chunk_ids: readonly string[];
}

/** The audit's five queries, each answered by exactly one chunk of the fixture. */
export const RETRIEVAL_FIXTURE_QUERIES: readonly RetrievalFixtureQuery[] = [
  { id: "rgold_fixture_lease", query: "how many days notice to end the office lease", expected_chunk_ids: ["lease#7"] },
  { id: "rgold_fixture_holiday", query: "how many paid holiday days does an employee get", expected_chunk_ids: ["handbook#7"] },
  { id: "rgold_fixture_refund", query: "how quickly do we refund a cancelled subscription", expected_chunk_ids: ["refunds#7"] },
  { id: "rgold_fixture_payroll", query: "what does the payroll provider charge per employee", expected_chunk_ids: ["vendors#7"] },
  { id: "rgold_fixture_laptop", query: "what happens when a company laptop is lost", expected_chunk_ids: ["security#7"] },
];

/** Writes the documents under `sourceDir` and imports them through the real pipeline. */
export async function importRetrievalFixture(brain: Brain, sourceDir: string, now?: () => Date): Promise<void> {
  const files = Object.entries(RETRIEVAL_FIXTURE_DOCS).map(([name, text]) => {
    const file = path.join(sourceDir, name);
    fs.writeFileSync(file, text, "utf8");
    return file;
  });
  await ingestDocuments({ brain, paths: files, ...(now === undefined ? {} : { now }) });
}
