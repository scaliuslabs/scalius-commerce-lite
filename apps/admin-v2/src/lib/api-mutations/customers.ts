// Customers & marketing writes: tags (one customer, or many from the list),
// a staff consent record, and saved segments. Each returns the API payload;
// screens refresh the queries they show.
import {
  deleteApiV1AdminCustomersByIdAddressesByAddressId,
  deleteApiV1AdminCustomersSegmentsBySegmentId,
  postApiV1AdminCustomersByIdAddresses,
  postApiV1AdminCustomersByIdAddressesByAddressIdDefault,
  putApiV1AdminCustomersByIdAddressesByAddressId,
  postApiV1AdminCustomersSegments,
  postApiV1AdminCustomersTagsBulk,
  putApiV1AdminCustomersByIdMarketing,
  putApiV1AdminCustomersByIdTags,
  putApiV1AdminCustomersSegmentsBySegmentId,
} from "@scalius/api-client/sdk";
import { apiData, type ApiBody } from "../api";

export type BulkCustomerTagsBody = ApiBody<typeof postApiV1AdminCustomersTagsBulk>;
export type CustomerConsentBody = ApiBody<typeof putApiV1AdminCustomersByIdMarketing>;
export type CustomerSegmentBody = ApiBody<typeof postApiV1AdminCustomersSegments>;

/** Adds and/or removes up to 10 tags on up to 500 customers in one request. */
export const bulkUpdateCustomerTags = (body: BulkCustomerTagsBody) =>
  apiData(postApiV1AdminCustomersTagsBulk({ body }));

/** Replaces one customer's tags; resolves with the tags as stored. */
export const saveCustomerTags = (id: string, tags: string[]) =>
  apiData(putApiV1AdminCustomersByIdTags({ path: { id }, body: { tags } }));

/** Records consent a customer gave (or withdrew) outside the store; resolves with the new consent payload. */
export const setCustomerConsent = (id: string, body: CustomerConsentBody) =>
  apiData(putApiV1AdminCustomersByIdMarketing({ path: { id }, body }));

export const createCustomerSegment = (body: CustomerSegmentBody) =>
  apiData(postApiV1AdminCustomersSegments({ body }));

/** Saves a segment at the revision it was loaded at (409 when someone saved first). */
export const updateCustomerSegment = (segmentId: string, expectedRevision: number, body: CustomerSegmentBody) =>
  apiData(putApiV1AdminCustomersSegmentsBySegmentId({ path: { segmentId }, body: { expectedRevision, ...body } }));

/** Refused (409) while a discount is limited to the segment. */
export const deleteCustomerSegment = (segmentId: string) =>
  apiData(deleteApiV1AdminCustomersSegmentsBySegmentId({ path: { segmentId } }));

export type CustomerAddressBody = ApiBody<typeof postApiV1AdminCustomersByIdAddresses>;

/** The address book: a write resolves with the saved address (a delete with nothing). */
export const createCustomerAddress = (id: string, body: CustomerAddressBody) =>
  apiData(postApiV1AdminCustomersByIdAddresses({ path: { id }, body }));

export const updateCustomerAddress = (id: string, addressId: string, body: CustomerAddressBody) =>
  apiData(putApiV1AdminCustomersByIdAddressesByAddressId({ path: { id, addressId }, body }));

export const setDefaultCustomerAddress = (id: string, addressId: string) =>
  apiData(postApiV1AdminCustomersByIdAddressesByAddressIdDefault({ path: { id, addressId } }));

/** When the default goes, the most recently changed other address becomes the default. */
export const deleteCustomerAddress = (id: string, addressId: string) =>
  apiData(deleteApiV1AdminCustomersByIdAddressesByAddressId({ path: { id, addressId } }));
