require("dotenv").config({ path: require('path').join(__dirname, '.env') });
const express = require('express')
const cors = require('cors')
console.log("RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID);
const { sequelize } = require('./config/db.js')
const authRoutes = require('./routes/auth.js')
const productRoutes = require("./routes/products.js");
const orderRoutes = require("./routes/orders.js");
const pkg = require("./config/upload.js");
const { UPLOAD_ROOT } = pkg;
const Cart = require("./models/Cart.js");
const CartItem = require("./models/CartItem.js");
const User = require("./models/User.js");
const Product = require("./models/Product.js");
const cartRoutes = require("./routes/cart.js");
const Order = require("./models/Order.js");
const OrderItem = require("./models/OrderItem.js");
const Wallet = require("./models/Wallet.js");
const WalletTransaction = require("./models/WalletTransaction.js");
const walletRoutes = require("./routes/wallet.js");
const deliveryCharge = require("./routes/deliveryCharge.js");
const user = require("./routes/user.js");
const bannerRoutes = require("./routes/banners.js");
const Address = require("./models/Address.js");
const addressRoutes = require("./routes/address.js");
const razorpayRoutes = require("./routes/razorpay.js");
const paymentsRoutes = require("./routes/payments.js");
const Payment = require("./models/Payment.js");
const BinaryNode = require("./models/BinaryNode.js");
const Referral = require("./models/Referral.js");
const referralRoutes = require("./routes/referrals.js");
const binaryRoutes = require("./routes/binary.js");
const ReferralLink = require("./models/ReferralLink.js");
const ReferralEdge = require("./models/ReferralEdge.js");
const referralTreeRoutes = require("./routes/referralTree.js");
const settingsRoutes = require("./routes/settings.js");
const AppSetting = require("./models/AppSetting.js");
const PairPending = require("./models/PairPending.js");
const PairMatch = require("./models/PairMatch.js");
const reportsRoutes = require("./routes/reports.js");
const pairsRoutes = require("./routes/pairs.js");
const withdrawalRoutes = require("./routes/withdrawals.js");
const awardsRoutes = require("./routes/awards.js");
const Category = require("./models/Category.js");
const SubCategory = require("./models/SubCategory.js");
const RankAchievement = require("./models/RankAchievement.js");
const RankSetting = require("./models/RankSetting.js");
const categoryRoutes = require("./routes/categories.js");
const subCategoryRoutes = require("./routes/subcategories.js");
const Contact = require("./models/Contact.js");
const contactsRoutes = require("./routes/contacts.js");




const path = require("path");


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
