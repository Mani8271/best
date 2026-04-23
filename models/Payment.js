const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/db.js");
const Order = require("./Order.js");
const User = require("./User.js");

const Payment = sequelize.define(
  "Payment",
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },

    userId: { type: DataTypes.INTEGER, allowNull: false },
    orderId: { type: DataTypes.INTEGER, allowNull: false },

    provider: {
      type: DataTypes.ENUM("RAZORPAY", "WALLET", "COD"),
      allowNull: false,
      defaultValue: "RAZORPAY",
    },

    amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },

    status: {
      // INITIATED -> SUCCESS / FAILED
      type: DataTypes.ENUM("INITIATED", "SUCCESS", "FAILED"),
      allowNull: false,
      defaultValue: "INITIATED",
    },

    // Razorpay fields (nullable for wallet/cod)
    razorpayOrderId: { type: DataTypes.STRING },
    razorpayPaymentId: { type: DataTypes.STRING },
    razorpaySignature: { type: DataTypes.STRING },

    failureReason: { type: DataTypes.STRING },
    raw: { type: DataTypes.JSON }, // store full response/webhook payload
  },
  {
    tableName: "payments",
  }
);



module.exports = Payment;
