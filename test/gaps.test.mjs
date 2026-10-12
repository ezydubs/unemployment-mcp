import { test } from "node:test";
import assert from "node:assert/strict";
const { applicationUploadMeta, uploadEndpoint } = await import("../dist/tools/documents.js");
const { summarizeCourse } = await import("../dist/tools/employment.js");

test("application upload metadata mirrors sub-type.uploadMetadata and picks the step's endpoint", () => {
  const category = { categoryId: "0021", name: "Supporting documents", cmsCode: "SUPDOC", context: "client" };
  assert.deepEqual(applicationUploadMeta(category, "REF1"), {
    context: "client",
    category: "Supporting documents",
    parentCategory: "SUPDOC",
    subCategory: "0021",
    workType: "GenericUpload",
    applicationReference: "REF1",
  });
  assert.equal(uploadEndpoint("identity"), "/rest/document/uploadIdentity");
  assert.equal(uploadEndpoint("supporting"), "/rest/document/uploadSupporting");
  assert.throws(() => applicationUploadMeta(null, "REF1"), /category/);
});

test("course summary", () => {
  assert.deepEqual(summarizeCourse({ courseId: "C1", title: "Forklift licence", shortDescription: "Two-day course", providerName: "Example Training", providerEmailId: "x@example.com" }), [
    "C1: Forklift licence — Two-day course",
    "Provider: Example Training (x@example.com)",
  ]);
});
