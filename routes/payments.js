import express from "express";
import auth from "../middleware/auth.js";
import Payment from "../models/Payment.js";
import Order from "../models/Order.js";
import isAdmin from "../middleware/isAdmin.js";
import User from "../models/User.js";

const router = express.Router();
router.get("/admin/all", auth, isAdmin, async (req, res) => {
  try {
    const addresses = await Address.findAll({
      include: [
        {
          model: User,
          as: "user", // ✅ IMPORTANT (matches Address.belongsTo(User,{as:"user"}))
          attributes: ["id", "name", "email", "phone"],
          required: false,
        },
      ],
      order: [["id", "DESC"]],
    });

    res.json({ total: addresses.length, addresses });
  } catch (e) {
    console.error("GET /api/addresses/admin/all error =>", e);
    res.status(500).json({ msg: "Failed to load addresses", err: e.message });
  }
});

router.get("/admin", auth, isAdmin, async (req, res) => {
  try {
    const { status, provider, purpose, search } = req.query;

    const where = {};

    if (status) where.status = status;
    if (provider) where.provider = provider;
    if (purpose) where.purpose = purpose;

    const payments = await Payment.findAll({
      where,
      include: [
        {
          model: User,
          attributes: ["id", "name", "email", "phone"],
          required: false,
        },
        {
          model: Order,
          required: false,
        },
      ],
      order: [["id", "DESC"]],
    });

    // 🔍 search filter (client-friendly)
    let filtered = payments;

    if (search) {
      const q = search.toLowerCase();

      filtered = payments.filter((p) => {
        const pid = String(p.id || "");
        const rpOrder = String(p.razorpayOrderId || "").toLowerCase();
        const rpPay = String(p.razorpayPaymentId || "").toLowerCase();
        const orderId = String(p.orderId || "");
        const uname = String(p.User?.name || "").toLowerCase();
        const phone = String(p.User?.phone || "");

        return (
          pid.includes(q) ||
          orderId.includes(q) ||
          rpOrder.includes(q) ||
          rpPay.includes(q) ||
          uname.includes(q) ||
          phone.includes(q)
        );
      });
    }

    res.json({
      total: filtered.length,
      payments: filtered,
    });
  } catch (e) {
    console.error("ADMIN PAYMENTS ERROR =>", e);
    res.status(500).json({ msg: "Failed to load payments" });
  }
});

/**
 * =====================================================
 * ✅ ADMIN: GET SINGLE PAYMENT
 * GET /api/payments/admin/:id
 * =====================================================
 */
router.get("/admin/:id", auth, isAdmin, async (req, res) => {
  try {
    const payment = await Payment.findByPk(req.params.id, {
      include: [
        { model: User, attributes: ["id", "name", "email", "phone"] },
        { model: Order },
      ],
    });

    if (!payment) {
      return res.status(404).json({ msg: "Payment not found" });
    }

    res.json(payment);
  } catch (e) {
    res.status(500).json({ msg: "Failed to load payment" });
  }
});

/**
 * ✅ USER: list my payments
 * GET /api/payments
 */
router.get("/", auth, async (req, res) => {
  try {
    const payments = await Payment.findAll({
      where: { userId: req.user.id },
      include: [{ model: Order }],
      order: [["id", "DESC"]],
    });
    res.json(payments);
  } catch (e) {
    res.status(500).json({ msg: "Failed to load payments" });
  }
});

/**
 * ✅ USER: payments for one order
 * GET /api/payments/order/:orderId
 */
router.get("/order/:orderId", auth, async (req, res) => {
  try {
    const rows = await Payment.findAll({
      where: { userId: req.user.id, orderId: req.params.orderId },
      order: [["id", "DESC"]],
    });
    res.json(rows);
  } catch {
    res.status(500).json({ msg: "Failed to load payments for order" });
  }
});




export default router;
