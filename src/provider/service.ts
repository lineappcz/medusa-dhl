import { createHash } from "node:crypto"
import { MedusaError } from "@medusajs/framework/utils"
import type {
  IFulfillmentProvider,
  CreateFulfillmentResult,
  FulfillmentOption,
} from "@medusajs/framework/types"
import {
  DhlExpressHttpAdapter,
  type CreateCarrierShipmentCommand,
} from "../client"
import { RedisOperationStore, type OperationStore } from "./operation-store"

type CreateArgs = Parameters<IFulfillmentProvider["createFulfillment"]>
export type DhlProviderOptions = {
  environment: "test" | "production"
  username: string
  password: string
  accountNumber: string
  productCode: string
  redisUrl?: string
  operationStore?: OperationStore
  namespace: string
  buildShipment: (...args: CreateArgs) => Promise<CreateCarrierShipmentCommand>
  storeLabel: (input: {
    shipmentId: string
    content: Buffer
    format: string
  }) => Promise<string>
  fetchImpl?: typeof fetch
}

export default class DhlProvider implements IFulfillmentProvider {
  static identifier = "dhl"
  private readonly client: DhlExpressHttpAdapter
  private readonly store: OperationStore
  static validateOptions(options: Record<string, unknown>) {
    if (
      !options.username ||
      !options.password ||
      !options.accountNumber ||
      !options.productCode ||
      !options.namespace ||
      (!options.redisUrl && !options.operationStore) ||
      typeof options.buildShipment !== "function" ||
      typeof options.storeLabel !== "function"
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "DHL requires account credentials, productCode, namespace, durable storage, buildShipment and storeLabel",
      )
    }
  }
  constructor(
    _container: Record<string, unknown>,
    private readonly options: DhlProviderOptions,
  ) {
    DhlProvider.validateOptions(options as unknown as Record<string, unknown>)
    this.client = new DhlExpressHttpAdapter(options)
    this.store =
      options.operationStore ??
      new RedisOperationStore(options.redisUrl!, `${options.namespace}:dhl`)
  }
  getIdentifier() {
    return DhlProvider.identifier
  }
  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [{ id: "dhl-express-address", name: "DHL Express address" }]
  }
  async validateOption(data: Record<string, unknown>) {
    return data.id === "dhl-express-address"
  }
  async canCalculate() {
    return false
  }
  async calculatePrice(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Configure a flat Medusa shipping price from your DHL Express contract",
    )
  }
  async validateFulfillmentData(
    option: Record<string, unknown>,
    data: Record<string, unknown>,
    context: Parameters<IFulfillmentProvider["validateFulfillmentData"]>[2],
  ) {
    if (!(await this.validateOption(option)))
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Unknown DHL Express shipping option",
      )
    if (!context.shipping_address?.country_code)
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A shipping address is required",
      )
    return {}
  }
  async createFulfillment(
    ...args: CreateArgs
  ): Promise<CreateFulfillmentResult> {
    const command = await this.options.buildShipment(...args)
    // Medusa deletes a failed fulfillment and creates a new ID on retry. Use a
    // durable packing-operation ID and serialize uncertain writes per order.
    const orderId = args[2]?.id
    const operationId = args[4]?.shipping_operation_id
    if (
      typeof orderId !== "string" ||
      !orderId ||
      typeof operationId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Order ID and stable additional_data.shipping_operation_id are required",
      )
    }
    const resource = `order:${orderId}`
    command.idempotencyKey = `${resource}:shipment:${operationId}`
    command.externalReference = createHash("sha256")
      .update(command.idempotencyKey)
      .digest("hex")
      .slice(0, 32)
    command.serviceCode = this.options.productCode
    const shipment = await this.store.run(
      resource,
      `create:${operationId}`,
      command,
      async () => {
        const result = await this.client.createShipment(command)
        return { result, state: { shipment: result } }
      },
    )
    const labelUrl = shipment.label?.reference
    if (!labelUrl || !labelUrl.startsWith("https://"))
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "storeLabel must return an authenticated HTTPS label endpoint",
      )
    return {
      data: {
        carrier_shipment_id: shipment.carrierShipmentId,
        label_url: labelUrl,
      },
      labels: [
        {
          tracking_number: shipment.trackingNumber,
          tracking_url: shipment.trackingUrl ?? "",
          label_url: labelUrl,
        },
      ],
    }
  }
  async cancelFulfillment(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Cancel the shipment in DHL Express and reconcile it before changing Medusa fulfillment state",
    )
  }
  async createReturnFulfillment(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "DHL Express returns are not supported in this release",
    )
  }
  async getFulfillmentDocuments(data: Record<string, unknown>) {
    return this.documents(data)
  }
  async getShipmentDocuments(data: Record<string, unknown>) {
    return this.documents(data)
  }
  async retrieveDocuments(data: Record<string, unknown>, type: string) {
    if (type !== "label")
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Only labels are supported",
      )
    return this.documents(data)
  }
  async getReturnDocuments(): Promise<never> {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Return documents are not supported",
    )
  }
  private documents(data: Record<string, unknown>) {
    return [{ label_url: data.label_url }]
  }
  async __shutdown() {
    await this.store.close?.()
  }
}
