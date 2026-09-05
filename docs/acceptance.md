# Scope, parity and acceptance

## Automated release gate

Every release runs type checking (including configuration examples), Medusa's
recommended lint rules, Jest with coverage thresholds, a TypeScript declaration
build, formatting and packed-provider/client import smoke tests. CI exercises
Node 22/24 and Medusa 2.19.0/2.20.1. See the exact release commit's Actions run and
coverage artifact for evidence. No percentage is a claim of semantic completeness.

## Extraction and ownership

The protocol client was extracted from a working application integration. The
application's custom order, legal, production and database-ledger logic is outside
the package. Existing consumers can adopt the `/client` exports without replacing
their durable workflows. New Medusa apps can register the native provider.

| Capability                            | Public client | Native provider              | Host application                          |
| ------------------------------------- | ------------- | ---------------------------- | ----------------------------------------- |
| Protocol request/response validation  | Yes           | Uses client                  | Supplies authoritative input              |
| Credentials and environment selection | Yes           | Startup configuration        | Supplies own account secrets              |
| Status reads and conservative mapping | Yes           | Lifecycle integration        | Schedules recovery/polling                |
| External write reservation            | Caller-owned  | Persistent operation journal | Provides durable Redis or OperationStore  |
| Business-specific order rules         | No            | No                           | Retains its own workflows                 |
| Unknown write outcome recovery        | Typed failure | Blocks retries               | Operator reconciles authoritative records |

## DHL Express

- Retained: official test/production endpoints, Basic authentication, configured
  product code, domestic parcel requests, timestamp/timezone handling, PDF/ZPL
  label requests, tracking and conservative unknown event mapping.
- Added: native fulfillment provider, actual label-byte storage callback and
  stable order-level operation journal. The standalone client's callback
  remains optional for compatibility with applications storing responses themselves.
- Caller-owned: packing, address checks, tracking schedules, private label access,
  contracted product and flat shipping prices.
- Outside 0.1: international/customs, COD, pickups, returns, automatic cancellation,
  rates and all DHL products other than Express.

Merchant acceptance: obtain MyDHL test credentials and an enabled domestic product,
create a permitted test shipment, open its real label and check tracking. Before
production verify the contracted product against the merchant account.

## Evidence limits

Automated tests use synthetic provider responses, real cryptographic signatures
where applicable and a real local/CI Redis with isolated test namespaces. They do
not contact carrier/bank accounts and are not live-provider certification. Host
application adoption and live merchant acceptance are separate release evidence.
