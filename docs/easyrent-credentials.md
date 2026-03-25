# Easyrent Integration — Required Credentials

The following values are needed per shop to connect AlpChat to Easyrent.
All values go into the `shops` table in the database.

---

## 1. Access ID
**Field:** `easyrent_accessid`

The ScanCode credential from Easyrent Maintenance.
Used as `accessId` in every API call.

---

## 2. Server URLs

**Field:** `easyrent_host`
The shop's server hostname.
Example: `shop.easyrent.at`

**Field:** `easyrent_soap_url`
Full endpoint URL for the SOAP service (used for customer and reservation creation).
Example: `http://shop.easyrent.at/ISWebService/ISWebService`

**Field:** `easyrent_rest_base_url`
Base URL for the REST adapter.
Example: `http://shop.easyrent.at/easyrest/rest`
