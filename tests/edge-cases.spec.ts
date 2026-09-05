import {
  CarrierIntegrationError,
  asCarrierIntegrationError,
} from "../src/client/errors"
import { isCarrierTrackingAdapter } from "../src/client/types"
import { DhlExpressHttpAdapter } from "../src/client/dhl"
import { shipmentCommand } from "./fixtures"

describe("protocol rejection and recovery boundaries", () => {
  it("recognizes cross-package carrier errors and tracking capability", () => {
    const error = new CarrierIntegrationError({
      code: "TEST",
      message: "synthetic",
    })
    expect(asCarrierIntegrationError(error)).toBe(error)
    expect(
      asCarrierIntegrationError(new Error("private provider payload")),
    ).toMatchObject({ outcome: "UNKNOWN", code: "CARRIER_OUTCOME_UNKNOWN" })
    expect(
      isCarrierTrackingAdapter({
        provider: "packeta",
        isConfigured: true,
        createShipment: jest.fn(),
      }),
    ).toBe(false)
    expect(
      isCarrierTrackingAdapter(
        new DhlExpressHttpAdapter({
          environment: "test",
          username: "test",
          password: "test",
          accountNumber: "123456789",
        }),
      ),
    ).toBe(true)
  })
})
