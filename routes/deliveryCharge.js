import express from "express";
import DeliveryCharge from "../models/DeliveryCharge.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";

const router = express.Router();

/* ================= GET ALL SLABS (ADMIN) ================= */
// GET /api/delivery-charges
router.get("/", auth, async (req, res) => {
  try {
    const slabs = await DeliveryCharge.findAll({
      order: [["minAmount", "ASC"]],
    });
    res.json(slabs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= CREATE SLAB (ADMIN) ================= */
// POST /api/delivery-charges
// body: { minAmount:0, maxAmount:50, charge:5 }
router.post("/", auth, async (req, res) => {
  try {
    const { minAmount, maxAmount, charge, isActive } = req.body;

    if (minAmount == null || charge == null) {
      return res.status(400).json({ msg: "minAmount and charge required" });
    }

    const slab = await DeliveryCharge.create({
      minAmount,
      maxAmount: maxAmount === "" ? null : (maxAmount ?? null),
      charge,
      isActive: isActive ?? true,
    });

    res.status(201).json(slab);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Create failed" });
  }
});

/* ================= UPDATE SLAB (ADMIN) ================= */
// PUT /api/delivery-charges/:id
router.put("/:id", auth, async (req, res) => {
  try {
    const slab = await DeliveryCharge.findByPk(req.params.id);
    if (!slab) return res.status(404).json({ msg: "Not found" });

    const { minAmount, maxAmount, charge, isActive } = req.body;

    await slab.update({
      minAmount: minAmount ?? slab.minAmount,
      maxAmount: maxAmount === "" ? null : (maxAmount ?? slab.maxAmount),
      charge: charge ?? slab.charge,
      isActive: isActive ?? slab.isActive,
    });

    res.json(slab);
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Update failed" });
  }
});

/* ================= DELETE SLAB (ADMIN) ================= */
// DELETE /api/delivery-charges/:id
router.delete("/:id", auth,  async (req, res) => {
  try {
    const slab = await DeliveryCharge.findByPk(req.params.id);
    if (!slab) return res.status(404).json({ msg: "Not found" });

    await slab.destroy(); // hard delete
    // OR soft delete:
    // slab.isActive = false; await slab.save();

    res.json({ msg: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ msg: "Delete failed" });
  }
});

export default router;
