import express from 'express'
import cors from 'cors'
// import dotenv from 'dotenv'
import "dotenv/config";
import { sequelize } from './config/db.js'
import authRoutes from './routes/auth.js'
import productRoutes from "./routes/products.js";
import orderRoutes from "./routes/orders.js";

import { UPLOAD_ROOT } from "./config/upload.js";
import Cart from "./models/Cart.js";
import CartItem from "./models/CartItem.js";
import User from "./models/User.js";
import Product from "./models/Product.js";
import cartRoutes from "./routes/cart.js";
import Order from "./models/Order.js";
import OrderItem from "./models/OrderItem.js";
import Wallet from "./models/Wallet.js";
import WalletTransaction from "./models/WalletTransaction.js";
import walletRoutes from "./routes/wallet.js";
import deliveryCharge from "./routes/deliveryCharge.js";
import user from "./routes/user.js";
import bannerRoutes from "./routes/banners.js";
import Address from "./models/Address.js";
import addressRoutes from "./routes/address.js";
import razorpayRoutes from "./routes/razorpay.js";
import paymentsRoutes from "./routes/payments.js";
import Payment from "./models/Payment.js";
import BinaryNode from "./models/BinaryNode.js";
import Referral from "./models/Referral.js";
import referralRoutes from "./routes/referrals.js";
import binaryRoutes from "./routes/binary.js";
import ReferralLink from "./models/ReferralLink.js";
import ReferralEdge from "./models/ReferralEdge.js";
import referralTreeRoutes from "./routes/referralTree.js";
import settingsRoutes from "./routes/settings.js";
import AppSetting from "./models/AppSetting.js";
import PairPending from "./models/PairPending.js";
import PairMatch from "./models/PairMatch.js";
import reportsRoutes from "./routes/reports.js";
import pairsRoutes from "./routes/pairs.js";
import withdrawalRoutes from "./routes/withdrawals.js";
import awardsRoutes from "./routes/awards.js";
import Category from "./models/Category.js";
import SubCategory from "./models/SubCategory.js";
import RankAchievement from "./models/RankAchievement.js";
import RankSetting from "./models/RankSetting.js";
import categoryRoutes from "./routes/categories.js";
import subCategoryRoutes from "./routes/subcategories.js";
import Contact from "./models/Contact.js";
import contactsRoutes from "./routes/contacts.js";




import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express()

app.use(cors())
app.use(express.json())


// app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/uploads", express.static(UPLOAD_ROOT));

/* routes */
app.use('/api/auth', authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/deliverycharges", deliveryCharge);
app.use("/api/users", user);

app.use("/api/banners", bannerRoutes);
app.use("/api/addresses", addressRoutes);

app.use("/api/razorpay", razorpayRoutes);


app.use("/api/payments", paymentsRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/binary", binaryRoutes);
// app.use("/api/referrals-tree", referralTreeRoutes);
app.use("/api/settings", settingsRoutes);
// app.use("/api/binary", referralTreeRoutes);
app.use("/api/pairs", pairsRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/reports", reportsRoutes);
app.use("/api/awards", awardsRoutes);


app.use("/api/categories", categoryRoutes);
app.use("/api/subcategories", subCategoryRoutes);
app.use("/api/contacts", contactsRoutes);

/* relations */
Cart.belongsTo(User, { foreignKey: "userId" });
User.hasOne(Cart, { foreignKey: "userId" });

Cart.hasMany(CartItem, { foreignKey: "cartId", onDelete: "CASCADE" });
CartItem.belongsTo(Cart, { foreignKey: "cartId" });

CartItem.belongsTo(Product, { foreignKey: "productId" });
Product.hasMany(CartItem, { foreignKey: "productId" });

// User ↔ Order
Order.belongsTo(User, { foreignKey: "userId" });
User.hasMany(Order, { foreignKey: "userId" });

// Offline order: track which admin created it
Order.belongsTo(User, { foreignKey: "createdByAdminId", as: "CreatedByAdmin" });
Order.belongsTo(User, { foreignKey: "deliveredByAdminId", as: "DeliveredByAdmin" });

// Order ↔ OrderItem
Order.hasMany(OrderItem, { foreignKey: "orderId", onDelete: "CASCADE" });
OrderItem.belongsTo(Order, { foreignKey: "orderId" });

// OrderItem ↔ Product
OrderItem.belongsTo(Product, { foreignKey: "productId" });
Product.hasMany(OrderItem, { foreignKey: "productId" });


// User ↔ Wallet
Wallet.belongsTo(User, { foreignKey: "userId", as: "user" });
User.hasOne(Wallet, { foreignKey: "userId" });

// Wallet ↔ WalletTransaction
Wallet.hasMany(WalletTransaction, { foreignKey: "walletId", onDelete: "CASCADE", as: "transactions" });
WalletTransaction.belongsTo(Wallet, { foreignKey: "walletId", as: "wallet" });
// user ↔ Adress
User.hasMany(Address, { foreignKey: "userId", as: "addresses", onDelete: "CASCADE" });
Address.belongsTo(User, { foreignKey: "userId", as: "user" });
// order ↔ Adress
Order.belongsTo(Address, { foreignKey: { name: "addressId", allowNull: true } }); // ✅ important
Address.hasMany(Order, { foreignKey: { name: "addressId", allowNull: true } });

Payment.belongsTo(User, { foreignKey: "userId" });
Payment.belongsTo(Order, { foreignKey: "orderId" });

Order.hasMany(Payment, { foreignKey: "orderId" });
User.hasMany(Payment, { foreignKey: "userId" });


ReferralLink.belongsTo(User, { foreignKey: "sponsorId" });

Referral.belongsTo(User, { foreignKey: "sponsorId", as: "sponsor" });
Referral.belongsTo(User, { foreignKey: "referredUserId", as: "referredUser" });

ReferralEdge.belongsTo(User, { foreignKey: "sponsorId", as: "sponsor" });
ReferralEdge.belongsTo(User, { foreignKey: "childId", as: "child" });

RankAchievement.belongsTo(User, { foreignKey: "userId" });
User.hasMany(RankAchievement, { foreignKey: "userId" });

Category.hasMany(SubCategory, { foreignKey: "categoryId", as: "subCategories" });
SubCategory.belongsTo(Category, { foreignKey: "categoryId", as: "category" });

User.belongsTo(User, { foreignKey: "sponsorId", as: "sponsor" });
User.hasMany(User, { foreignKey: "sponsorId", as: "referrals" });

// Pair associations
PairPending.belongsTo(User, { foreignKey: "uplineUserId", as: "upline" });
PairPending.belongsTo(User, { foreignKey: "downlineUserId", as: "downline" });
PairMatch.belongsTo(User, { foreignKey: "uplineUserId", as: "upline" });
PairMatch.belongsTo(User, { foreignKey: "leftUserId", as: "leftUser" });
PairMatch.belongsTo(User, { foreignKey: "rightUserId", as: "rightUser" });

(async () => {
  try {
    await sequelize.authenticate();
    console.log("✅ MySQL authenticated");

    await sequelize.sync(); // ✅ creates new tables / adds columns safely
    console.log("✅ MySQL synced");

    app.listen(3000, () => console.log("Server running on 3000"));
  } catch (err) {
    console.error("❌ DB ERROR:", err);
    process.exit(1);
  }
})();
// sequelize.sync({alter:true}).then(() => console.log('MySQL connected'))

// app.listen(3000, () => console.log('Server running on 3000'))