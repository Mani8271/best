import express from "express";
import Cart from "../models/Cart.js";
import CartItem from "../models/CartItem.js";
import Product from "../models/Product.js";
import auth from "../middleware/auth.js";

const router = express.Router();

/* ================= GET CART ================= */
// router.get("/", auth, async (req, res) => {
//   try {
//     const cart = await Cart.findOne({
//       where: { userId: req.user.id },
//       include: [{
//         model: CartItem,
//         include: [Product],
//       }],
//     });

//     res.json(cart || { CartItems: [] });
//   } catch {
//     res.status(500).json({ msg: "Failed to get cart" });
//   }
// });
router.get("/", auth, async (req, res) => {
  try {
    const cart = await Cart.findOne({
      where: { userId: req.user.id },
      include: [
        {
          model: CartItem,
          include: [Product],
        },
      ],
    });

    if (!cart) {
      return res.json({
        CartItems: [],
        itemsCount: 0,
        totalQty: 0,
        totalAmount: 0,
      });
    }

    let itemsCount = cart.CartItems.length;
    let totalQty = 0;
    let totalAmount = 0;

    cart.CartItems.forEach(item => {
      totalQty += item.qty;
      totalAmount += item.qty * Number(item.Product.price);
    });

    res.json({
      id: cart.id,
      userId: cart.userId,
      CartItems: cart.CartItems,
      itemsCount,     // ✅ how many items
      totalQty,       // ✅ total quantity
      totalAmount,    // ✅ final price
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Failed to get cart" });
  }
});

/* ================= ADD TO CART ================= */
router.post("/", auth, async (req, res) => {
  try {
    const { productId, qty = 1 } = req.body;
    if (qty < 1) return res.status(400).json({ msg: "Qty must be >= 1" });

    let cart = await Cart.findOne({ where: { userId: req.user.id } });
    if (!cart) cart = await Cart.create({ userId: req.user.id });

    const [item, created] = await CartItem.findOrCreate({
      where: { cartId: cart.id, productId },
      defaults: { qty },
    });

    if (!created) {
      item.qty += qty;
      await item.save();
    }

    res.json({ msg: "Added to cart" });
  } catch(e) {
      console.error("ADD CART ERROR =>", e);              // ✅ full error
  res.status(500).json({ msg: "Add failed", err: e.message });
  }
});

/* ================= UPDATE QTY ================= */
router.put("/:id", auth, async (req, res) => {
  try {
    const { qty } = req.body;
    if (qty < 1) return res.status(400).json({ msg: "Qty must be >= 1" });

    const cart = await Cart.findOne({ where: { userId: req.user.id } });
    if (!cart) return res.status(404).json({ msg: "Cart not found" });

    const item = await CartItem.findOne({
      where: { id: req.params.id, cartId: cart.id },
    });
    if (!item) return res.status(404).json({ msg: "Item not found" });

    item.qty = qty;
    await item.save();

    res.json({ msg: "Qty updated" });
  } catch {
    res.status(500).json({ msg: "Update failed" });
  }
});

/* ================= REMOVE ITEM ================= */
router.delete("/:id", auth, async (req, res) => {
  try {
    const cart = await Cart.findOne({ where: { userId: req.user.id } });
    if (!cart) return res.status(404).json({ msg: "Cart not found" });

    await CartItem.destroy({
      where: { id: req.params.id, cartId: cart.id },
    });

    res.json({ msg: "Item removed" });
  } catch {
    res.status(500).json({ msg: "Remove failed" });
  }
});

export default router;
