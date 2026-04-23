import { DataTypes } from "sequelize";
import { sequelize } from "../config/db.js";

const Order = sequelize.define(
  "Order",
  {
    userId: { type: DataTypes.INTEGER, allowNull: false },

    totalAmount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    addressId: { type: DataTypes.INTEGER, allowNull: true },

    deliveredOn: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    status: {
      type: DataTypes.ENUM("PENDING", "PAID", "CANCELLED", "DELIVERED"),
      allowNull: false,
      defaultValue: "PENDING",
    },

    paymentMethod: {
      type: DataTypes.ENUM("COD", "WALLET", "RAZORPAY", "CASH", "UPI", "BANK", "OFFLINE"),
      allowNull: false,
    },
    totalDiscount: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    },

    paymentStatus: {
      type: DataTypes.ENUM("PENDING", "SUCCESS", "FAILED"),
      allowNull: false,
      defaultValue: "PENDING",
    },
    deliveryCharge: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },

    createdByAdminId: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    deliveredByAdminId: { type: DataTypes.INTEGER, allowNull: true, defaultValue: null },
    orderType: { type: DataTypes.ENUM("ONLINE", "OFFLINE"), allowNull: false, defaultValue: "ONLINE" },

  },
  { timestamps: true }
);

export default Order;
