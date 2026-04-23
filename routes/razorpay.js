import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import auth from "../middleware/auth.js";

import Order from "../models/Order.js";
import Payment from "../models/Payment.js";

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * ✅ CREATE ORDER + CREATE PAYMENT RECORD (INITIATED)
 * POST /api/razorpay/create-order
 * Body: { orderId }   (recommended: tie to your DB order)
 */
router.post("/create-order", auth, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ msg: "orderId required" });

    const dbOrder = await Order.findOne({ where: { id: orderId, userId: req.user.id } });
    if (!dbOrder) return res.status(404).json({ msg: "Order not found" });

    const amountRupees = Number(dbOrder.totalAmount);
    if (!amountRupees || amountRupees <= 0) return res.status(400).json({ msg: "Invalid order amount" });

    const options = {
      amount: Math.round(amountRupees * 100),
      currency: "INR",
      receipt: `rcpt_${req.user.id}_${Date.now()}`,
      notes: { userId: String(req.user.id), orderId: String(orderId) },
    };

    const rpOrder = await razorpay.orders.create(options);

    // ✅ create payment row
    const payRow = await Payment.create({
      userId: req.user.id,
      orderId: dbOrder.id,
      provider: "RAZORPAY",
      amount: dbOrder.totalAmount,
      status: "INITIATED",
      razorpayOrderId: rpOrder.id,
      raw: rpOrder,
    });

    return res.json({
      paymentId: payRow.id,              // ✅ your DB payment row id
      orderId: rpOrder.id,               // ✅ razorpay order id
      amount: rpOrder.amount,
      currency: rpOrder.currency,
      receipt: rpOrder.receipt,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    console.error("RAZORPAY CREATE ORDER ERROR =>", e);
    return res.status(500).json({ msg: "Failed to create order", err: e.message });
  }
});

/**
 * ✅ VERIFY PAYMENT SIGNATURE + MARK PAYMENT SUCCESS + ORDER PAID
 * POST /api/razorpay/verify
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
router.post("/verify", auth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ msg: "Missing razorpay fields" });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    // find payment row by razorpayOrderId
    const payRow = await Payment.findOne({
      where: { razorpayOrderId: razorpay_order_id, userId: req.user.id },
    });
    if (!payRow) return res.status(404).json({ msg: "Payment record not found" });

    if (expected !== razorpay_signature) {
      await payRow.update({
        status: "FAILED",
        failureReason: "Invalid signature",
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        raw: { ...payRow.raw, verify: req.body },
      });
      return res.status(400).json({ msg: "Invalid signature" });
    }

    // ✅ mark payment success
    await payRow.update({
      status: "SUCCESS",
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      raw: { ...payRow.raw, verify: req.body },
    });

    // ✅ mark order paid
    await Order.update(
      { status: "PAID", paymentStatus: "SUCCESS", paymentMethod: "RAZORPAY" },
      { where: { id: payRow.orderId, userId: req.user.id } }
    );

    return res.json({ msg: "Payment verified successfully", paymentDbId: payRow.id });
  } catch (e) {
    console.error("RAZORPAY VERIFY ERROR =>", e);
    return res.status(500).json({ msg: "Verification failed", err: e.message });
  }
});

/**
 * ✅ OPTIONAL: MARK PAYMENT FAILED (frontend cancel/failure)
 * POST /api/razorpay/failed
 * Body: { razorpay_order_id, reason? }
 */
router.post("/failed", auth, async (req, res) => {
  try {
    const { razorpay_order_id, reason = "Payment failed/cancelled" } = req.body;
    if (!razorpay_order_id) return res.status(400).json({ msg: "razorpay_order_id required" });

    const payRow = await Payment.findOne({
      where: { razorpayOrderId: razorpay_order_id, userId: req.user.id },
    });
    if (!payRow) return res.status(404).json({ msg: "Payment record not found" });

    await payRow.update({ status: "FAILED", failureReason: reason });

    await Order.update(
      { status: "PENDING", paymentStatus: "FAILED", paymentMethod: "RAZORPAY" },
      { where: { id: payRow.orderId, userId: req.user.id } }
    );

    res.json({ msg: "Payment marked as failed" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Failed to mark payment failed", err: e.message });
  }
});

export default router;
