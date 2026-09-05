import type { IFulfillmentProvider } from "@medusajs/framework/types"
import DhlProvider from "../src/provider/service"
import { MemoryStore } from "./memory-store"
import { shipmentCommand } from "./fixtures"

const setup = () => {
  const fetchImpl = jest.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          shipmentTrackingNumber: "5374534546",
          packages: [{ trackingNumber: "JD014600004617230779" }],
          documents: [
            { typeCode: "label", imageFormat: "PDF", content: "JVBERi0xLjQ=" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
  )
  const storeLabel = jest
    .fn()
    .mockResolvedValue("https://shop.example.com/admin/labels/5374534546")
  const options = {
    environment: "test" as const,
    username: "test-user",
    password: "test-password",
    accountNumber: "123456789",
    productCode: "N",
    namespace: "test",
    operationStore: new MemoryStore(),
    fetchImpl,
    storeLabel,
    buildShipment: async () => ({
      ...shipmentCommand(),
      pickupPointCode: undefined,
    }),
  }
  return {
    provider: new DhlProvider({}, options),
    fetchImpl,
    storeLabel,
    options,
  }
}
describe("Medusa DHL fulfillment provider", () => {
  it("blocks a replacement operation after an uncertain carrier write", async () => {
    const { provider, fetchImpl } = setup()
    fetchImpl.mockImplementation(async () => {
      throw new Error("connection lost")
    })
    const args: Parameters<IFulfillmentProvider["createFulfillment"]> = [
      {},
      [],
      { id: "order_uncertain" },
      { id: "ful_old" },
      { shipping_operation_id: "packing_original" },
    ]
    await expect(provider.createFulfillment(...args)).rejects.toThrow()
    const writesBefore = fetchImpl.mock.calls.filter(
      ([, init]) => init.method === "POST",
    ).length
    args[3] = { id: "ful_replacement" }
    args[4] = { shipping_operation_id: "packing_bypass" }
    await expect(provider.createFulfillment(...args)).rejects.toThrow(
      "Reconcile",
    )
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(writesBefore)
  })
  it("creates once and stores actual label bytes using the configured product", async () => {
    const { provider, fetchImpl, storeLabel } = setup()
    const args: Parameters<IFulfillmentProvider["createFulfillment"]> = [
      { serviceCode: "tampered" },
      [],
      { id: "order_1" },
      { id: "ful_1" },
      { shipping_operation_id: "packing_1" },
    ]
    const result = await provider.createFulfillment(...args)
    args[3] = { id: "ful_retry_new_id" }
    expect(await provider.createFulfillment(...args)).toEqual(result)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).productCode).toBe("N")
    expect(storeLabel.mock.calls[0][0].content.toString()).toBe("%PDF-1.4")
    expect(result.labels[0].label_url).toMatch(/^https:/)
    expect(await provider.getFulfillmentDocuments(result.data)).toEqual(
      await provider.getShipmentDocuments(result.data),
    )
    expect(await provider.retrieveDocuments(result.data, "label")).toHaveLength(
      1,
    )
    await provider.__shutdown()
  })
  it("validates address options and refuses unsupported operations", async () => {
    const { provider } = setup()
    expect(provider.getIdentifier()).toBe("dhl")
    expect(await provider.getFulfillmentOptions()).toHaveLength(1)
    expect(await provider.validateOption({ id: "wrong" })).toBe(false)
    const context = { shipping_address: { country_code: "cz" } } as Parameters<
      IFulfillmentProvider["validateFulfillmentData"]
    >[2]
    expect(
      await provider.validateFulfillmentData(
        { id: "dhl-express-address" },
        {},
        context,
      ),
    ).toEqual({})
    await expect(
      provider.validateFulfillmentData({ id: "bad" }, {}, context),
    ).rejects.toThrow()
    await expect(
      provider.validateFulfillmentData(
        { id: "dhl-express-address" },
        {},
        {} as typeof context,
      ),
    ).rejects.toThrow()
    expect(await provider.canCalculate()).toBe(false)
    await expect(provider.calculatePrice()).rejects.toThrow()
    await expect(provider.cancelFulfillment()).rejects.toThrow()
    await expect(provider.createReturnFulfillment()).rejects.toThrow()
    await expect(provider.getReturnDocuments()).rejects.toThrow()
    await expect(provider.retrieveDocuments({}, "invoice")).rejects.toThrow()
    await expect(provider.createFulfillment({}, [], {}, {})).rejects.toThrow(
      "ID",
    )
    expect(() => DhlProvider.validateOptions({})).toThrow()
  })
})
