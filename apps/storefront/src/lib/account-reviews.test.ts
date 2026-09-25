import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import {
  REVIEW_FORM_ACTION,
  lineReviewMarkup,
  pickReviewFormCopy,
  readBuyerReviews,
  readLineReviewExtra,
  readReviewNotice,
  reviewFlagForApi,
  reviewNoticeText,
  safeReviewReturnPath,
  toReviewListMarkup,
  withReviewStatus,
  writtenReviewListMarkup,
  type BuyerReview,
} from "./account-reviews";

const copy = pickReviewFormCopy(null, ENGLISH_CHECKOUT_LANGUAGE_DATA);
const receipt = { kind: "receipt" as const, orderId: "ord_1" };
const account = { kind: "account" as const };

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

const ownReview: BuyerReview = {
  id: "rev_1",
  orderId: "ord_1",
  orderItemId: "item_1",
  productId: "prod_1",
  productName: "Blue shirt",
  productSlug: "blue-shirt",
  variantLabel: "Size: M",
  rating: 4,
  title: "Good \"fit\"",
  body: "Soft <cotton>",
  displayName: "Rahim K.",
  status: "published",
  reply: { body: "Thanks!", repliedAt: "2026-09-14T08:00:00.000Z" },
  createdAt: "2026-09-12T08:00:00.000Z",
  publishedAt: "2026-09-12T08:00:00.000Z",
  editedAt: null,
  version: 3,
  canEdit: true,
};

describe("the review form without JavaScript", () => {
  it("is a method=post form to the review endpoint with required star radios and ids only", () => {
    const doc = parse(lineReviewMarkup("item_1", { eligible: true, review: null }, {
      access: receipt,
      returnTo: "/order-success?orderId=ord_1",
      copy,
    }));
    const form = doc.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe(REVIEW_FORM_ACTION);
    const stars = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="rating"]')];
    expect(stars.map((star) => star.value)).toEqual(["5", "4", "3", "2", "1"]);
    expect(stars.every((star) => star.required)).toBe(true);
    // Every star has a label a screen reader can name.
    expect(stars.every((star) => doc.querySelector(`label[for="${star.id}"]`)?.textContent?.includes("out of 5 stars"))).toBe(true);
    const hidden = Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value]));
    expect(hidden).toMatchObject({ intent: "submit", orderItemId: "item_1", orderId: "ord_1", returnTo: "/order-success?orderId=ord_1" });
    expect(hidden.clientKey).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    // The receipt proof never enters the form or its action.
    expect(form.outerHTML).not.toMatch(/token|proof/i);
    expect(form.querySelector('textarea[name="body"]')?.getAttribute("maxlength")).toBe("5000");
    expect(form.querySelector('input[name="title"]')?.getAttribute("maxlength")).toBe("120");
    expect(form.querySelector('input[name="displayName"]')?.getAttribute("maxlength")).toBe("60");
  });

  it("renders nothing for a line that can't be reviewed and has no review", () => {
    expect(lineReviewMarkup("item_1", { eligible: false, review: null }, { access: account, returnTo: "/account/reviews", copy })).toBe("");
    expect(lineReviewMarkup("item_1", null, { access: account, returnTo: "/account/reviews", copy })).toBe("");
  });

  it("shows the buyer's review with its status, and edits it in place when the page has it", () => {
    const doc = parse(lineReviewMarkup("item_1", { eligible: false, review: { id: "rev_1", rating: 4, status: "published" } }, {
      access: receipt,
      returnTo: "/order-success?orderId=ord_1",
      copy,
      review: ownReview,
    }));
    expect(doc.body.textContent).toContain("Published");
    const [edit, withdraw] = [...doc.querySelectorAll("form")];
    expect(edit.querySelector<HTMLInputElement>('input[name="rating"][value="4"]')?.checked).toBe(true);
    expect(edit.querySelector<HTMLInputElement>('input[name="title"]')?.value).toBe("Good \"fit\"");
    expect(edit.querySelector("textarea")?.value).toBe("Soft <cotton>");
    expect(Object.fromEntries([...edit.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((input) => [input.name, input.value])))
      .toMatchObject({ intent: "edit", reviewId: "rev_1", version: "3" });
    expect(withdraw.querySelector<HTMLInputElement>('input[name="intent"]')?.value).toBe("withdraw");
    expect(withdraw.getAttribute("method")).toBe("post");
  });

  it("links the account order page's review to the account Reviews page to edit it", () => {
    const html = lineReviewMarkup("item_1", { eligible: false, review: { id: "rev_1", rating: 5, status: "pending" } }, {
      access: account,
      returnTo: "/account/orders/ord_1",
      copy,
      editHref: (id) => `/account/reviews#written-${id}`,
    });
    const doc = parse(html);
    expect(doc.body.textContent).toContain("Waiting for approval");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("/account/reviews#written-rev_1");
    expect(doc.querySelector("form")).toBeNull();
  });
});

describe("outcomes", () => {
  it("come back as a flag, the line id and its anchor; never text", () => {
    const location = withReviewStatus("/order-success?orderId=ord_1&review=old", "exists", "item_1", "rev_9");
    expect(location).toBe("/order-success?orderId=ord_1&review=exists&reviewLine=item_1&reviewRef=rev_9#review-item_1");
    expect(readReviewNotice(new URL(location, "https://x.test").search)).toEqual({ flag: "exists", lineId: "item_1", reviewRef: "rev_9" });
    expect(readReviewNotice("?review=<script>")).toBeNull();
  });

  it("map every API refusal to kind copy", () => {
    expect(reviewFlagForApi(409, "REVIEW_EXISTS", null, account)).toBe("exists");
    expect(reviewFlagForApi(409, "REVIEW_NOT_ELIGIBLE", null, account)).toBe("not_eligible");
    expect(reviewFlagForApi(409, "REVIEW_NOT_EDITABLE", null, account)).toBe("not_editable");
    expect(reviewFlagForApi(409, "CONFLICT", null, account)).toBe("changed");
    expect(reviewFlagForApi(403, "REVIEWS_DISABLED", null, receipt)).toBe("disabled");
    expect(reviewFlagForApi(429, "RATE_LIMITED", null, account)).toBe("rate_limited");
    expect(reviewFlagForApi(503, "SERVICE_UNAVAILABLE", null, account)).toBe("unavailable");
    expect(reviewFlagForApi(400, "VALIDATION_ERROR", "rating", account)).toBe("rating");
    expect(reviewFlagForApi(400, "VALIDATION_ERROR", "body", account)).toBe("invalid");
    expect(reviewFlagForApi(401, "UNAUTHORIZED", null, account)).toBe("signin");
    expect(reviewFlagForApi(404, "NOT_FOUND", null, receipt)).toBe("receipt");
    expect(reviewNoticeText("exists", copy)).toBe("You've already reviewed this product.");
    expect(reviewNoticeText("published", pickReviewFormCopy(null, BANGLA_CHECKOUT_LANGUAGE_DATA))).toContain("ধন্যবাদ");
  });

  it("only return to the buyer's own order and review pages", () => {
    expect(safeReviewReturnPath("/order-success?orderId=ord_1")).toBe("/order-success?orderId=ord_1");
    expect(safeReviewReturnPath("/account/orders/ord_1#reviews")).toBe("/account/orders/ord_1");
    expect(safeReviewReturnPath("/account/reviews")).toBe("/account/reviews");
    expect(safeReviewReturnPath("https://evil.test/account/reviews")).toBeNull();
    expect(safeReviewReturnPath("//evil.test/account/reviews")).toBeNull();
    expect(safeReviewReturnPath("/checkout")).toBeNull();
  });

  it("show the notice on its own line, with \"Edit your review\" for an existing review", () => {
    const html = lineReviewMarkup("item_1", { eligible: true, review: null }, {
      access: account,
      returnTo: "/account/reviews",
      copy,
      notice: { flag: "exists", lineId: "item_1", reviewRef: "rev_9" },
      editHref: (id) => `/account/reviews#written-${id}`,
    });
    const doc = parse(html);
    expect(doc.querySelector('[role="alert"]')?.textContent).toContain("You've already reviewed this product.");
    expect(doc.querySelector('[role="alert"] a')?.getAttribute("href")).toBe("/account/reviews#written-rev_9");
    // An error reopens the form.
    expect(doc.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(lineReviewMarkup("item_2", { eligible: true, review: null }, {
      access: account,
      returnTo: "/account/reviews",
      copy,
      notice: { flag: "exists", lineId: "item_1", reviewRef: "rev_9" },
    })).not.toContain("already reviewed");
  });
});

describe("API shapes", () => {
  it("read extras and the buyer's lists, leaving malformed rows out", () => {
    expect(readLineReviewExtra({ eligible: true, review: null })).toEqual({ eligible: true, review: null });
    expect(readLineReviewExtra({ eligible: false, review: { id: "rev_1", rating: 6, status: "published" } })).toEqual({ eligible: false, review: null });
    expect(readBuyerReviews({ toReview: [{ orderId: "ord_1", orderItemId: "item_2", orderNumber: "1042", productName: "Mug" }, { orderId: "x y" }], reviews: [ownReview, { id: "bad" }] }))
      .toMatchObject({ toReview: [{ orderItemId: "item_2", orderNumber: "1042" }], reviews: [{ id: "rev_1" }] });
    expect(readBuyerReviews({ reviews: [] })).toBeNull();
  });
});

describe("the account Reviews page", () => {
  const options = {
    copy,
    notice: null,
    storeName: "Dhaka Store",
    imageUrl: () => null,
    formatDate: () => "12 Sep 2026",
  };

  it("lists what to review with its form (the first one open) and the reviews written with status, reply and edit", () => {
    const toReview = parse(toReviewListMarkup([
      { orderId: "ord_1", orderNumber: "1042", orderItemId: "item_2", productId: "p", productName: "Mug", productSlug: "mug", variantLabel: null, imageUrl: null, fulfilledAt: "2026-09-12T08:00:00.000Z" },
      { orderId: "ord_1", orderNumber: "1042", orderItemId: "item_3", productId: "q", productName: "Cup", productSlug: null, variantLabel: null, imageUrl: null, fulfilledAt: null },
    ], options));
    expect(toReview.body.textContent).toContain("Order #1042 · Delivered 12 Sep 2026");
    expect([...toReview.querySelectorAll("details")].map((details) => details.hasAttribute("open"))).toEqual([true, false]);
    expect(toReview.querySelectorAll('form[method="post"]')).toHaveLength(2);

    const written = parse(writtenReviewListMarkup([ownReview, { ...ownReview, id: "rev_2", orderItemId: "item_4", status: "rejected", canEdit: false, reply: null }], options));
    expect(written.getElementById("written-rev_1")).not.toBeNull();
    expect(written.body.textContent).toContain("Response from Dhaka Store");
    expect(written.body.textContent).toContain("Not published");
    // A rejected review can't be edited or removed by the buyer.
    expect(written.querySelectorAll("li")[1]!.querySelector("form")).toBeNull();
  });
});
