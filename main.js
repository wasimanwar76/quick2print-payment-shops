require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================

const cors = require("cors");

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// ==========================================
// SUPABASE CONFIG
// ==========================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==========================================
// CASHFREE CONFIG HELPER
// Gets credentials from shops table
// ==========================================

async function getShopCashfreeConfig(shopId) {
  if (!shopId) {
    throw new Error("Shop ID is required.");
  }

  const { data: shop, error } = await supabase
    .from("shops")
    .select(
      `
      shop_id,
      shop_name,
      status,
      whatsapp_number,
      cashfree_app_id,
      cashfree_secret_key,
      cashfree_env
    `,
    )
    .eq("shop_id", shopId)
    .single();

  if (error) {
    throw new Error(`Failed to get shop configuration: ${error.message}`);
  }

  if (!shop) {
    throw new Error("Shop not found.");
  }

  if (shop.status !== "active") {
    throw new Error("Shop is not active.");
  }

  if (!shop.cashfree_app_id) {
    throw new Error("Cashfree App ID is not configured for this shop.");
  }

  if (!shop.cashfree_secret_key) {
    throw new Error("Cashfree Secret Key is not configured for this shop.");
  }

  const environment = String(shop.cashfree_env || "SANDBOX").toUpperCase();

  if (!["SANDBOX", "PRODUCTION"].includes(environment)) {
    throw new Error("Invalid Cashfree environment. Use SANDBOX or PRODUCTION.");
  }

  const apiUrl =
    environment === "PRODUCTION"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

  const headers = {
    "Content-Type": "application/json",
    "x-client-id": shop.cashfree_app_id,
    "x-client-secret": shop.cashfree_secret_key,
    "x-api-version": "2022-09-01",
  };

  return {
    shop,
    environment,
    apiUrl,
    headers,
  };
}

// ==========================================
// API 1: CREATE PAYMENT
// ==========================================

app.post("/api/payment/create", async (req, res) => {
  try {
    const {
      shopId,
      totalFiles,
      totalPages,
      amountCharged,
      customerPhone,
      customerName,
    } = req.body;

    // --------------------------------------
    // VALIDATION
    // --------------------------------------

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    const amount = Number(amountCharged);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid payment amount is required.",
      });
    }

    // --------------------------------------
    // GET SHOP CASHFREE CONFIG
    // --------------------------------------

    const { shop, environment, apiUrl, headers } =
      await getShopCashfreeConfig(shopId);

    // --------------------------------------
    // CREATE LOCAL PRINT ORDER FIRST
    // --------------------------------------

    const { data: printOrder, error: orderError } = await supabase
      .from("print_orders")
      .insert({
        shop_id: shopId,

        total_files: Number.isFinite(Number(totalFiles))
          ? Number(totalFiles)
          : 1,

        total_pages: Number.isFinite(Number(totalPages))
          ? Number(totalPages)
          : 0,

        amount_charged: amount,

        payment_mode: "UPI",

        status: "pending",

        payment_status: "PENDING",

        payment_amount: amount,

        payment_currency: "INR",

        payment_environment: environment,
      })
      .select("order_id")
      .single();

    if (orderError) {
      throw new Error(`Failed to create print order: ${orderError.message}`);
    }

    const orderId = printOrder.order_id;

    // --------------------------------------
    // CASHFREE ORDER ID
    // --------------------------------------

    const cashfreeOrderId = `Q2P_${shopId}_${orderId.replace(/-/g, "")}`;

    // --------------------------------------
    // CASHFREE PAYLOAD
    // --------------------------------------

    const payload = {
      order_amount: amount,

      order_currency: "INR",

      order_id: cashfreeOrderId,

      customer_details: {
        customer_id: `CUST_${shopId}_${Date.now()}`,

        customer_phone: String(customerPhone) || shop.whatsapp_number,

        customer_name: customerName || "Quick2Print Customer",
      },

      order_meta: {
        return_url:
          `https://www.yourdomain.com/payment-status.html` +
          `?order_id=${encodeURIComponent(orderId)}` +
          `&shop_id=${encodeURIComponent(shopId)}`,
      },
    };

    // --------------------------------------
    // CREATE CASHFREE ORDER
    // --------------------------------------

    const cfResponse = await axios.post(`${apiUrl}/orders`, payload, {
      headers,
    });

    const paymentSessionId = cfResponse.data?.payment_session_id;

    if (!paymentSessionId) {
      throw new Error("Cashfree did not return payment_session_id.");
    }

    // --------------------------------------
    // UPDATE PRINT ORDER
    // --------------------------------------

    const { error: updateError } = await supabase
      .from("print_orders")
      .update({
        payment_order_id: cashfreeOrderId,

        payment_session_id: paymentSessionId,

        payment_status: "PENDING",

        payment_amount: amount,

        payment_currency: "INR",

        payment_environment: environment,
      })
      .eq("order_id", orderId);

    if (updateError) {
      console.error("Print order update error:", updateError);

      throw new Error("Payment created but database update failed.");
    }

    // --------------------------------------
    // RESPONSE
    // --------------------------------------

    return res.status(200).json({
      success: true,

      order_id: orderId,

      payment_order_id: cashfreeOrderId,

      payment_session_id: paymentSessionId,

      amount: amount,

      currency: "INR",

      payment_status: "PENDING",

      environment: environment,

      shop_id: shopId,
    });
  } catch (error) {
    console.error(
      "Create Payment Error:",
      error.response?.data || error.message,
    );

    return res.status(500).json({
      success: false,

      message:
        error.response?.data?.message ||
        error.message ||
        "Payment creation failed.",
    });
  }
});

// ==========================================
// API 2: VERIFY PAYMENT
// ==========================================

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { orderId, shopId } = req.body;

    // --------------------------------------
    // VALIDATION
    // --------------------------------------

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId is required.",
      });
    }

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    console.log(`🔍 Verifying order: ${orderId}`);

    // --------------------------------------
    // GET SHOP CASHFREE CONFIG
    // --------------------------------------

    const { apiUrl, headers, environment } =
      await getShopCashfreeConfig(shopId);

    // --------------------------------------
    // GET LOCAL PRINT ORDER
    // --------------------------------------

    const { data: localOrder, error: localOrderError } = await supabase
      .from("print_orders")
      .select(
        `
        order_id,
        shop_id,
        payment_order_id,
        payment_status,
        payment_amount
      `,
      )
      .eq("order_id", orderId)
      .eq("shop_id", shopId)
      .single();

    if (localOrderError || !localOrder) {
      return res.status(404).json({
        success: false,
        message: "Print order not found.",
      });
    }

    if (!localOrder.payment_order_id) {
      return res.status(400).json({
        success: false,
        message: "Cashfree payment order ID not found.",
      });
    }

    // --------------------------------------
    // GET CASHFREE ORDER STATUS
    // --------------------------------------

    const response = await axios.get(
      `${apiUrl}/orders/${encodeURIComponent(localOrder.payment_order_id)}`,

      {
        headers,
      },
    );

    const cashfreeOrder = response.data;

    const cashfreeStatus = String(
      cashfreeOrder?.order_status || "",
    ).toUpperCase();

    console.log("Cashfree status:", cashfreeStatus);

    // --------------------------------------
    // GET PAYMENT DETAILS
    // --------------------------------------

    let paymentData = null;

    try {
      const paymentResponse = await axios.get(
        `${apiUrl}/orders/${encodeURIComponent(
          localOrder.payment_order_id,
        )}/payments`,

        {
          headers,
        },
      );

      const payments = Array.isArray(paymentResponse.data)
        ? paymentResponse.data
        : [];

      if (payments.length > 0) {
        /*
         * Prefer a successful payment.
         * Otherwise use the latest payment.
         */

        paymentData =
          payments.find(
            (payment) =>
              String(payment.payment_status || "").toUpperCase() === "SUCCESS",
          ) || payments[payments.length - 1];
      }
    } catch (paymentError) {
      console.warn(
        "Could not fetch payment details:",
        paymentError.response?.data || paymentError.message,
      );
    }

    // --------------------------------------
    // MAP CASHFREE STATUS
    // --------------------------------------

    let dbStatus = "PENDING";

    if (cashfreeStatus === "PAID") {
      dbStatus = "PAID";
    } else if (cashfreeStatus === "EXPIRED") {
      dbStatus = "EXPIRED";
    } else if (cashfreeStatus === "FAILED") {
      dbStatus = "FAILED";
    }

    // --------------------------------------
    // PAYMENT INFORMATION
    // --------------------------------------

    const cfPaymentId = paymentData?.cf_payment_id
      ? String(paymentData.cf_payment_id)
      : null;

    const paymentMethod = paymentData?.payment_method
      ? typeof paymentData.payment_method === "string"
        ? paymentData.payment_method
        : JSON.stringify(paymentData.payment_method)
      : null;

    const transactionReference =
      paymentData?.bank_reference ||
      paymentData?.payment_group ||
      paymentData?.cf_payment_id ||
      null;

    // --------------------------------------
    // TIMESTAMPS
    // --------------------------------------

    let paymentCompletedAt = null;

    if (dbStatus === "PAID") {
      paymentCompletedAt =
        paymentData?.payment_completion_time ||
        paymentData?.payment_time ||
        new Date().toISOString();
    }

    // --------------------------------------
    // ERROR MESSAGE
    // --------------------------------------

    let paymentErrorMessage = null;

    if (dbStatus === "FAILED") {
      paymentErrorMessage =
        paymentData?.payment_message ||
        paymentData?.error_details ||
        cashfreeOrder?.order_tags?.error ||
        "Payment failed.";
    }

    if (dbStatus === "EXPIRED") {
      paymentErrorMessage = "Payment order expired.";
    }

    // --------------------------------------
    // UPDATE PRINT ORDER
    // --------------------------------------

    const updateData = {
      payment_status: dbStatus,

      payment_verified_at: new Date().toISOString(),

      payment_environment: environment,
    };

    if (cfPaymentId) {
      updateData.cf_payment_id = cfPaymentId;
    }

    if (paymentMethod) {
      updateData.payment_method = paymentMethod;
    }

    if (transactionReference) {
      updateData.transaction_reference = String(transactionReference);
    }

    if (paymentCompletedAt) {
      updateData.payment_completed_at = paymentCompletedAt;
    }

    if (paymentErrorMessage) {
      updateData.payment_error_message = String(paymentErrorMessage);
    } else if (dbStatus === "PAID") {
      updateData.payment_error_message = null;
    }

    const { data: updatedOrder, error: updateError } = await supabase

      .from("print_orders")

      .update(updateData)

      .eq("order_id", orderId)

      .eq("shop_id", shopId)

      .select(
        `
        order_id,
        shop_id,
        payment_order_id,
        payment_status,
        payment_session_id,
        cf_payment_id,
        payment_amount,
        payment_currency,
        payment_method,
        payment_completed_at,
        payment_verified_at,
        transaction_reference,
        payment_error_message,
        payment_environment
      `,
      )

      .single();

    if (updateError) {
      console.error("Supabase Verify Update Error:", updateError);

      throw new Error("Failed to update payment information.");
    }

    // --------------------------------------
    // IF PAID
    // Move print order to processing
    // --------------------------------------

    if (dbStatus === "PAID") {
      const { error: processingError } = await supabase

        .from("print_orders")

        .update({
          status: "processing",
        })

        .eq("order_id", orderId)

        .eq("shop_id", shopId);

      if (processingError) {
        console.error("Failed to move order to processing:", processingError);
      }
    }

    // --------------------------------------
    // RESPONSE
    // --------------------------------------

    return res.status(200).json({
      success: true,

      order_id: orderId,

      payment_order_id: localOrder.payment_order_id,

      payment_status: dbStatus,

      cashfree_status: cashfreeStatus,

      payment_session_id: updatedOrder.payment_session_id,

      cf_payment_id: updatedOrder.cf_payment_id,

      payment_amount: updatedOrder.payment_amount,

      payment_method: updatedOrder.payment_method,

      transaction_reference: updatedOrder.transaction_reference,

      payment_completed_at: updatedOrder.payment_completed_at,

      payment_verified_at: updatedOrder.payment_verified_at,

      payment_error_message: updatedOrder.payment_error_message,

      environment: environment,
    });
  } catch (error) {
    console.error(
      "Verify Payment Error:",
      error.response?.data || error.message,
    );

    return res.status(500).json({
      success: false,

      message:
        error.response?.data?.message ||
        error.message ||
        "Payment verification failed.",
    });
  }
});

// ==========================================
// API 3: GET PAYMENT ORDER
// ==========================================

app.get("/api/payment/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    const { data, error } = await supabase

      .from("print_orders")

      .select(
        `
          order_id,
          shop_id,
          total_files,
          total_pages,
          amount_charged,
          payment_mode,
          status,
          created_at,
          completed_at,
          payment_status,
          payment_order_id,
          payment_session_id,
          cf_payment_id,
          payment_amount,
          payment_currency,
          payment_method,
          payment_completed_at,
          payment_verified_at,
          transaction_reference,
          payment_error_message,
          payment_environment
        `,
      )

      .eq("order_id", orderId)

      .eq("shop_id", shopId)

      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,

        message: "Payment order not found.",
      });
    }

    return res.status(200).json({
      success: true,

      order: data,
    });
  } catch (error) {
    console.error("Get Payment Order Error:", error.message);

    return res.status(500).json({
      success: false,

      message: "Failed to get payment order.",
    });
  }
});

// ==========================================
// API 4: HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,

    message: "Quick2Print Payment Server is running.",

    time: new Date().toISOString(),
  });
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Quick2Print Payment Server running on port ${PORT}`);
});
