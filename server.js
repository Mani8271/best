const path = require('path');
const fs = require('fs');
const envPath = path.join(__dirname, '.env');
console.log("Current Directory:", __dirname);
console.log(".env exists:", fs.existsSync(envPath));
if (fs.existsSync(envPath)) {
  console.log(".env size:", fs.statSync(envPath).size);
}
const result = require("dotenv").config({ path: envPath });
if (result.error) console.error("Dotenv Load Error:", result.error);
console.log("Injected keys:", Object.keys(result.parsed || {}));

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
const Investment = require("./models/Investment.js");
const InvestmentTransaction = require("./models/InvestmentTransaction.js");
const InvestmentWithdrawal = require("./models/InvestmentWithdrawal.js");
const InvestmentBankDetail = require("./models/InvestmentBankDetail.js");
const investmentRoutes = require("./routes/investment.js");









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
app.use("/api/investment", investmentRoutes);
app.use("/api/investments", investmentRoutes);


/* relations */
Investment.belongsTo(User, { foreignKey: "userId" });
User.hasOne(Investment, { foreignKey: "userId" });

InvestmentTransaction.belongsTo(User, { foreignKey: "userId" });
InvestmentTransaction.belongsTo(User, { foreignKey: "fromUserId", as: "fromUser" });

InvestmentWithdrawal.belongsTo(User, { foreignKey: "userId" });
User.hasMany(InvestmentWithdrawal, { foreignKey: "userId" });

InvestmentBankDetail.belongsTo(User, { foreignKey: "userId" });
User.hasOne(InvestmentBankDetail, { foreignKey: "userId" });

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

    await sequelize.sync({ alter: true }); // ✅ creates new tables & auto-syncs new columns safely
    console.log("✅ MySQL synced (alter mode)");

    // Auto-fix Txn #8 if recorded as 2% (₹1,000) instead of 5% (₹2,500) on live DB
    try {
      const [fixedTxn] = await sequelize.query(`
        UPDATE InvestmentTransactions 
        SET amount = 2500.00, 
            description = 'Direct Referral Commission (5%) from john2 (SI146320) investment of ₹50,000'
        WHERE (id = 8 OR description LIKE '%SI146320%' OR description LIKE '%john2%') AND amount < 2500;
      `);
      if (fixedTxn && fixedTxn.affectedRows > 0) {
        console.log("✅ Fixed Txn #8 commission to ₹2,500 (5%)");
        await sequelize.query(`
          UPDATE Investments 
          SET commissionBalance = commissionBalance + 1500.00
          WHERE userId = (
            SELECT id FROM Users WHERE userID = 'SI754188' OR email = 'john@gmail.com' LIMIT 1
          );
        `);
        console.log("✅ Added +₹1,500 difference to John's wallet commissionBalance");
      }
    } catch (migErr) {
      console.error("Txn #8 Migration fix error (non-fatal):", migErr.message);
    }

    // Schedule Daily ROI & Daily Level Commission cron job (runs every day at Midnight 00:00 AM)
    const cron = require("node-cron");
    const { processDailyPayouts } = require("./utils/dailyPayoutEngine.js");

    cron.schedule("0 0 * * *", async () => {
      console.log("⏰ [Cron] Triggering Daily ROI & Level Payouts...");
      try {
        await processDailyPayouts();
      } catch (err) {
        console.error("❌ [Cron] Error running daily payouts:", err);
      }
    });
    console.log("⏰ Daily Payout Cron Job Scheduled (Runs at 00:00 Midnight daily)");

    app.listen(3000, () => console.log("Server running on 3000"));
  } catch (err) {
    console.error("❌ DB ERROR:", err);
    process.exit(1);
  }
})();
// sequelize.sync({alter:true}).then(() => console.log('MySQL connected'))

// app.listen(3000, () => console.log('Server running on 3000'))
