import { createHash } from "node:crypto"

import { CarrierIntegrationError, carrierInvariant } from "./errors"
import { requestCarrierJson } from "./http-client"
import { asRecord, firstString } from "./response-mapping"
import { joinCarrierUrl } from "./safety"
import type {
  CarrierAddress,
  CarrierFetch,
  CarrierShipment,
  CarrierTrackingAdapter,
  CarrierTrackingSnapshot,
  CarrierTrackingStatus,
  CreateCarrierShipmentCommand,
} from "./types"

export const DHL_EXPRESS_API_BASE_URLS = {
  test: "https://express.api.dhl.com/mydhlapi/test",
  production: "https://express.api.dhl.com/mydhlapi",
} as const

export type DhlExpressEnvironment = keyof typeof DHL_EXPRESS_API_BASE_URLS

const DHL_TRACKING_STATUS = new Map<string, CarrierTrackingStatus>([
  ["OK", "DELIVERED"],
  ["DF", "IN_TRANSIT"],
  ["PU", "IN_TRANSIT"],
  ["AF", "IN_TRANSIT"],
  ["PL", "IN_TRANSIT"],
  ["WC", "OUT_FOR_DELIVERY"],
  ["RT", "RETURNED"],
])

const requiredText = (
  value: string | undefined,
  maximumLength: number,
  code: string,
  message: string,
): string => {
  const normalized = value?.trim()
  carrierInvariant(
    normalized &&
      normalized.length <= maximumLength &&
      !/[\r\n]/.test(normalized),
    code,
    message,
  )
  return normalized
}

const optionalText = (
  value: string | undefined,
  maximumLength: number,
  code: string,
  message: string,
): string | undefined => {
  if (!value?.trim()) return undefined
  return requiredText(value, maximumLength, code, message)
}

const toDhlAddress = (address: CarrierAddress) => {
  carrierInvariant(
    address.streetLines.length >= 1 && address.streetLines.length <= 3,
    "DHL_ADDRESS_LINES_INVALID",
    "DHL Express requires one to three address lines.",
  )
  const streetLines = address.streetLines.map((line) =>
    requiredText(
      line,
      45,
      "DHL_ADDRESS_INVALID",
      "DHL Express address line is invalid.",
    ),
  )
  const fullName = requiredText(
    address.name,
    255,
    "DHL_CONTACT_INVALID",
    "DHL Express contact name is invalid.",
  )
  const countryCode = address.countryCode.trim().toUpperCase()
  carrierInvariant(
    /^[A-Z]{2}$/.test(countryCode),
    "DHL_ADDRESS_INVALID",
    "DHL Express country code must use ISO 3166-1 alpha-2.",
  )

  return {
    postalAddress: {
      postalCode: requiredText(
        address.postalCode,
        12,
        "DHL_ADDRESS_INVALID",
        "DHL Express postal code is invalid.",
      ),
      cityName: requiredText(
        address.city,
        45,
        "DHL_ADDRESS_INVALID",
        "DHL Express city is invalid.",
      ),
      countryCode,
      addressLine1: streetLines[0],
      ...(streetLines[1] ? { addressLine2: streetLines[1] } : {}),
      ...(streetLines[2] ? { addressLine3: streetLines[2] } : {}),
    },
    contactInformation: {
      ...(optionalText(
        address.email,
        70,
        "DHL_CONTACT_INVALID",
        "DHL Express contact email is invalid.",
      )
        ? { email: address.email?.trim() }
        : {}),
      phone: requiredText(
        address.phone,
        70,
        "DHL_CONTACT_REQUIRED",
        "DHL Express requires a contact phone number.",
      ),
      companyName:
        optionalText(
          address.company,
          100,
          "DHL_CONTACT_INVALID",
          "DHL Express company name is invalid.",
        ) ?? fullName,
      fullName,
    },
  }
}

const zonedParts = (date: Date, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>

export const formatDhlPlannedShippingDateTime = (
  date: Date,
  timeZone: string,
): string => {
  carrierInvariant(
    !Number.isNaN(date.getTime()),
    "DHL_SHIPPING_DATE_INVALID",
    "DHL Express planned shipping date is invalid.",
  )
  let parts: Record<string, number>
  try {
    parts = zonedParts(date, timeZone)
  } catch {
    throw new CarrierIntegrationError({
      code: "DHL_TIME_ZONE_INVALID",
      message: "DHL Express shipping time zone is invalid.",
      outcome: "CONFIGURATION",
    })
  }
  const renderedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  const offsetMinutes = Math.round((renderedAsUtc - date.getTime()) / 60_000)
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const absoluteOffset = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0")
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, "0")
  const value = (part: string) => String(parts[part]).padStart(2, "0")

  return `${parts.year}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")} GMT${sign}${offsetHours}:${offsetRemainder}`
}

const messageReference = (idempotencyKey: string): string => {
  const digest = createHash("sha256").update(idempotencyKey).digest("hex")
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`
}

const dhlLabelOptions = (
  format: CreateCarrierShipmentCommand["labelFormat"] = "PDF_A6",
) => ({
  encodingFormat: format === "ZPL" ? "zpl" : "pdf",
  imageOptions: [
    {
      typeCode: "label",
      templateName: format === "PDF_A4" ? "ECOM26_84_A4_001" : "ECOM26_A6_002",
      isRequested: true,
      ...(format === "PDF_A4" ? { fitLabelsToA4: true } : {}),
    },
  ],
})

const parseDhlShipment = (
  response: unknown,
  command: CreateCarrierShipmentCommand,
): CarrierShipment => {
  const root = asRecord(response)
  const carrierShipmentId = firstString(root, ["shipmentTrackingNumber"])
  const packages = Array.isArray(root.packages) ? root.packages : []
  const firstPackage = asRecord(packages[0])
  const trackingNumber =
    firstString(firstPackage, ["trackingNumber"]) ?? carrierShipmentId
  const trackingUrl = firstString(root, ["trackingUrl"])
  const documents = Array.isArray(root.documents) ? root.documents : []
  const hasLabel = documents.some((document) => {
    const record = asRecord(document)
    return (
      firstString(record, ["typeCode"])?.toLowerCase() === "label" &&
      Boolean(firstString(record, ["content"]))
    )
  })

  carrierInvariant(
    carrierShipmentId && /^\d{10}$/.test(carrierShipmentId) && trackingNumber,
    "DHL_RESPONSE_INCOMPLETE",
    "DHL Express response is missing shipment identifiers.",
    "UNKNOWN",
  )
  carrierInvariant(
    hasLabel,
    "DHL_LABEL_MISSING",
    "DHL Express response is missing the requested shipping label.",
    "UNKNOWN",
  )
  if (trackingUrl) {
    let secure = false
    try {
      secure = new URL(trackingUrl).protocol === "https:"
    } catch {}
    carrierInvariant(
      secure,
      "DHL_TRACKING_URL_INVALID",
      "DHL Express returned an invalid tracking URL.",
      "UNKNOWN",
    )
  }

  return {
    provider: "dhl",
    carrierShipmentId,
    trackingNumber,
    trackingUrl,
    label: {
      reference: `dhl-image:${carrierShipmentId}:label`,
      format: command.labelFormat ?? "PDF_A6",
    },
  }
}

const dhlEventTimestamp = (
  event: Record<string, unknown>,
  fallback: Date,
): string => {
  const date = firstString(event, ["date"])
  const time = firstString(event, ["time"])
  const offset = firstString(event, ["GMTOffset"])
  if (
    date &&
    time &&
    offset &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    /^\d{2}:\d{2}:\d{2}$/.test(time) &&
    /^[+-]\d{2}:\d{2}$/.test(offset)
  ) {
    const parsed = new Date(`${date}T${time}${offset}`)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return fallback.toISOString()
}

const parseDhlTracking = (
  response: unknown,
  carrierShipmentId: string,
  observedAt: Date,
): CarrierTrackingSnapshot => {
  const root = asRecord(response)
  const shipments = Array.isArray(root.shipments) ? root.shipments : []
  const shipment = asRecord(shipments[0])
  const responseTrackingNumber = firstString(shipment, [
    "shipmentTrackingNumber",
  ])
  const events = Array.isArray(shipment.events) ? shipment.events : []
  const event = asRecord(events.at(-1))
  const rawStatus = firstString(event, ["typeCode"])?.toUpperCase()

  carrierInvariant(
    responseTrackingNumber === carrierShipmentId && rawStatus,
    "DHL_TRACKING_RESPONSE_INCOMPLETE",
    "DHL Express tracking response is incomplete or does not match the shipment.",
    "UNKNOWN",
  )
  const occurredAt = dhlEventTimestamp(event, observedAt)
  const eventDigest = createHash("sha256")
    .update(
      `${carrierShipmentId}:${rawStatus}:${firstString(event, ["date"]) ?? ""}:${firstString(event, ["time"]) ?? ""}:${firstString(event, ["GMTOffset"]) ?? ""}`,
    )
    .digest("hex")

  return {
    provider: "dhl",
    carrierShipmentId,
    eventId: `dhl_${eventDigest.slice(0, 32)}`,
    status: DHL_TRACKING_STATUS.get(rawStatus) ?? "UNKNOWN",
    rawStatus,
    occurredAt,
  }
}

export class DhlExpressHttpAdapter implements CarrierTrackingAdapter {
  readonly provider = "dhl" as const
  readonly isConfigured = true
  private readonly baseUrl: string

  constructor(
    private readonly config: {
      environment: DhlExpressEnvironment
      username: string
      password: string
      accountNumber: string
      contentDescription?: string
      shippingTimeZone?: string
      shippingLeadMinutes?: number
      fetchImpl?: CarrierFetch
      timeoutMs?: number
      now?: () => Date
      storeLabel?: (input: {
        shipmentId: string
        content: Buffer
        format: string
      }) => Promise<string>
    },
  ) {
    this.baseUrl = DHL_EXPRESS_API_BASE_URLS[config.environment]
    carrierInvariant(
      Boolean(this.baseUrl),
      "DHL_ENVIRONMENT_INVALID",
      "DHL Express environment must be test or production.",
      "CONFIGURATION",
    )
    carrierInvariant(
      /^\d{1,12}$/.test(config.accountNumber),
      "DHL_ACCOUNT_NUMBER_INVALID",
      "DHL Express account number is invalid.",
      "CONFIGURATION",
    )
    carrierInvariant(
      Boolean(config.username.trim() && config.password) &&
        !/[:\r\n]/.test(config.username) &&
        !/[\r\n]/.test(config.password),
      "DHL_CREDENTIALS_INVALID",
      "DHL Express API credentials are invalid.",
      "CONFIGURATION",
    )
    const leadMinutes = config.shippingLeadMinutes ?? 60
    carrierInvariant(
      Number.isInteger(leadMinutes) &&
        leadMinutes >= 15 &&
        leadMinutes <= 1_440,
      "DHL_SHIPPING_LEAD_INVALID",
      "DHL Express shipping lead time is invalid.",
      "CONFIGURATION",
    )
    formatDhlPlannedShippingDateTime(
      new Date((config.now?.() ?? new Date()).getTime() + leadMinutes * 60_000),
      config.shippingTimeZone ?? "Europe/Prague",
    )
  }

  private headers(messageReferenceValue: string) {
    return {
      accept: "application/json",
      "accept-language": "eng",
      authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`, "utf8").toString("base64")}`,
      "content-type": "application/json",
      "message-reference": messageReferenceValue,
      "x-version": "3.3.1",
    }
  }

  async createShipment(
    command: CreateCarrierShipmentCommand,
  ): Promise<CarrierShipment> {
    carrierInvariant(
      command.packages.length >= 1 && command.packages.length <= 999,
      "DHL_PACKAGES_INVALID",
      "DHL Express requires between one and 999 packages.",
    )
    for (const item of command.packages) {
      carrierInvariant(
        Number.isSafeInteger(item.weightGrams) && item.weightGrams > 0,
        "DHL_PACKAGE_WEIGHT_INVALID",
        "DHL Express package weight must use positive integer grams.",
      )
      const suppliedDimensions = [item.lengthMm, item.widthMm, item.heightMm]
      carrierInvariant(
        suppliedDimensions.every((value) => value === undefined) ||
          suppliedDimensions.every(
            (value) => Number.isSafeInteger(value) && Number(value) > 0,
          ),
        "DHL_PACKAGE_DIMENSIONS_INVALID",
        "DHL Express package dimensions must be all omitted or all positive integer millimetres.",
      )
    }
    carrierInvariant(
      !command.pickupPointCode,
      "DHL_PICKUP_POINT_UNSUPPORTED",
      "DHL Express address delivery does not accept a Packeta pickup point.",
    )
    carrierInvariant(
      !command.codValueMinor,
      "DHL_COD_UNSUPPORTED",
      "DHL Express cash on delivery is not enabled for this integration.",
    )
    carrierInvariant(
      command.shipper.countryCode.trim().toUpperCase() ===
        command.recipient.countryCode.trim().toUpperCase(),
      "DHL_CUSTOMS_DATA_REQUIRED",
      "Cross-border DHL Express shipments require a customs declaration that is not part of this command.",
    )
    const now = this.config.now?.() ?? new Date()
    const leadMinutes = this.config.shippingLeadMinutes ?? 60
    const requestReference = messageReference(command.idempotencyKey)
    const contentDescription = requiredText(
      this.config.contentDescription ?? "Goods",
      70,
      "DHL_CONTENT_DESCRIPTION_INVALID",
      "DHL Express content description is invalid.",
    )

    const response = await requestCarrierJson<unknown>({
      fetchImpl: this.config.fetchImpl,
      url: joinCarrierUrl(this.baseUrl, "/shipments"),
      method: "POST",
      headers: this.headers(requestReference),
      body: JSON.stringify({
        plannedShippingDateAndTime: formatDhlPlannedShippingDateTime(
          new Date(now.getTime() + leadMinutes * 60_000),
          this.config.shippingTimeZone ?? "Europe/Prague",
        ),
        pickup: { isRequested: false },
        productCode: requiredText(
          command.serviceCode,
          1,
          "DHL_PRODUCT_CODE_INVALID",
          "DHL Express product code must contain one character.",
        ),
        accounts: [{ typeCode: "shipper", number: this.config.accountNumber }],
        outputImageProperties: dhlLabelOptions(command.labelFormat),
        customerReferences: [
          {
            value: requiredText(
              command.externalReference,
              35,
              "DHL_REFERENCE_INVALID",
              "DHL Express customer reference is invalid.",
            ),
            typeCode: "CU",
          },
        ],
        customerDetails: {
          shipperDetails: toDhlAddress(command.shipper),
          receiverDetails: toDhlAddress(command.recipient),
        },
        content: {
          packages: command.packages.map((item, index) => ({
            weight: item.weightGrams / 1_000,
            ...(item.lengthMm && item.widthMm && item.heightMm
              ? {
                  dimensions: {
                    length: item.lengthMm / 10,
                    width: item.widthMm / 10,
                    height: item.heightMm / 10,
                  },
                }
              : {}),
            customerReferences: [
              { value: item.reference.slice(0, 35), typeCode: "CU" },
            ],
            description: contentDescription,
            referenceNumber: index + 1,
          })),
          isCustomsDeclarable: false,
          description: contentDescription,
          incoterm: "DAP",
          unitOfMeasurement: "metric",
        },
      }),
      timeoutMs: this.config.timeoutMs,
      maxAttempts: 1,
    })

    const shipment = parseDhlShipment(response, command)
    if (this.config.storeLabel) {
      const root = asRecord(response)
      const documents = Array.isArray(root.documents) ? root.documents : []
      const label = documents
        .map(asRecord)
        .find((item) => item.typeCode === "label")
      const content = String(label?.content ?? "")
      carrierInvariant(
        content.length <= 14_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(content),
        "DHL_LABEL_INVALID",
        "DHL returned invalid label content.",
        "UNKNOWN",
      )
      const reference = await this.config.storeLabel({
        shipmentId: shipment.carrierShipmentId,
        content: Buffer.from(content, "base64"),
        format: command.labelFormat ?? "PDF_A6",
      })
      carrierInvariant(
        Boolean(reference),
        "DHL_LABEL_STORAGE_FAILED",
        "Label storage returned no reference.",
        "UNKNOWN",
      )
      shipment.label = { reference, format: command.labelFormat ?? "PDF_A6" }
    }
    return shipment
  }

  async getTrackingStatus(
    carrierShipmentId: string,
  ): Promise<CarrierTrackingSnapshot> {
    carrierInvariant(
      /^\d{10}$/.test(carrierShipmentId),
      "DHL_TRACKING_NUMBER_INVALID",
      "DHL Express shipment tracking number is invalid.",
    )
    const requestReference = messageReference(`tracking:${carrierShipmentId}`)
    const path = `/shipments/${encodeURIComponent(carrierShipmentId)}/tracking?trackingView=all-checkpoints&levelOfDetail=shipment&requestGMTOffsetPerEvent=true`
    const response = await requestCarrierJson<unknown>({
      fetchImpl: this.config.fetchImpl,
      url: joinCarrierUrl(this.baseUrl, path),
      method: "GET",
      headers: this.headers(requestReference),
      timeoutMs: this.config.timeoutMs,
      maxAttempts: 3,
    })
    return parseDhlTracking(
      response,
      carrierShipmentId,
      this.config.now?.() ?? new Date(),
    )
  }
}
