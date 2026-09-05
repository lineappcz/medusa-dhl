import { DhlExpressHttpAdapter } from "../src/client/dhl"
import { shipmentCommand } from "./fixtures"
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
describe("carrier protocol", () => {
  it("creates a domestic DHL Express shipment with a requested private label", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        shipmentTrackingNumber: "5374534546",
        trackingUrl:
          "https://express.api.dhl.com/mydhlapi/shipments/5374534546/tracking",
        packages: [{ trackingNumber: "JD014600004617230779" }],
        documents: [
          { typeCode: "label", imageFormat: "PDF", content: "JVBERi0xLjQ=" },
        ],
      }),
    )
    const adapter = new DhlExpressHttpAdapter({
      environment: "test",
      username: "api-user",
      password: "api-password",
      accountNumber: "123456789",
      fetchImpl,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
    })
    const command = shipmentCommand()
    command.serviceCode = "I"
    command.pickupPointCode = undefined
    command.packages[0] = {
      ...command.packages[0],
      lengthMm: 300,
      widthMm: 200,
      heightMm: 50,
    }

    await expect(adapter.createShipment(command)).resolves.toEqual({
      provider: "dhl",
      carrierShipmentId: "5374534546",
      trackingNumber: "JD014600004617230779",
      trackingUrl:
        "https://express.api.dhl.com/mydhlapi/shipments/5374534546/tracking",
      label: {
        reference: "dhl-image:5374534546:label",
        format: "PDF_A6",
      },
    })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://express.api.dhl.com/mydhlapi/test/shipments")
    expect(init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("api-user:api-password").toString("base64")}`,
      "x-version": "3.3.1",
    })
    expect(init.headers["message-reference"]).toMatch(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/,
    )
    expect(JSON.parse(init.body)).toMatchObject({
      plannedShippingDateAndTime: "2026-09-05T15:00:00 GMT+02:00",
      pickup: { isRequested: false },
      productCode: "I",
      accounts: [{ typeCode: "shipper", number: "123456789" }],
      customerReferences: [{ value: "EXAMPLE-ORDER-0001", typeCode: "CU" }],
      content: {
        isCustomsDeclarable: false,
        description: "Goods",
        incoterm: "DAP",
        unitOfMeasurement: "metric",
        packages: [
          {
            weight: 1.25,
            dimensions: { length: 30, width: 20, height: 5 },
            referenceNumber: 1,
          },
        ],
      },
    })
  })
  it("maps the latest DHL Express checkpoint without inventing its timezone", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse({
        shipments: [
          {
            shipmentTrackingNumber: "5374534546",
            status: "Success",
            events: [
              {
                date: "2026-09-05",
                time: "10:00:00",
                GMTOffset: "+02:00",
                typeCode: "PU",
              },
              {
                date: "2026-09-06",
                time: "14:30:00",
                GMTOffset: "+02:00",
                typeCode: "OK",
              },
            ],
          },
        ],
      }),
    )
    const adapter = new DhlExpressHttpAdapter({
      environment: "test",
      username: "api-user",
      password: "api-password",
      accountNumber: "123456789",
      fetchImpl,
    })

    await expect(adapter.getTrackingStatus("5374534546")).resolves.toEqual({
      provider: "dhl",
      carrierShipmentId: "5374534546",
      eventId: expect.stringMatching(/^dhl_[a-f0-9]{32}$/),
      status: "DELIVERED",
      rawStatus: "OK",
      occurredAt: "2026-09-06T12:30:00.000Z",
    })
    expect(fetchImpl.mock.calls[0][0]).toContain(
      "/shipments/5374534546/tracking?trackingView=all-checkpoints&levelOfDetail=shipment&requestGMTOffsetPerEvent=true",
    )
  })
  it("rejects shipments without customs declarations", async () => {
    const adapter = new DhlExpressHttpAdapter({
      environment: "test",
      username: "api-user",
      password: "api-password",
      accountNumber: "123456789",
    })
    const command = shipmentCommand()
    command.serviceCode = "P"
    command.pickupPointCode = undefined
    command.recipient.countryCode = "DE"

    await expect(adapter.createShipment(command)).rejects.toMatchObject({
      code: "DHL_CUSTOMS_DATA_REQUIRED",
    })
  })
})
